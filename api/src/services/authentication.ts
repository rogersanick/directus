import jwt from 'jsonwebtoken';
import { Knex } from 'knex';
import ms from 'ms';
import { nanoid } from 'nanoid';
import getDatabase from '../database';
import emitter from '../emitter';
import env from '../env';
import { getAuthProvider } from '../auth';
import { DEFAULT_AUTH_PROVIDER } from '../constants';
import { InvalidCredentialsException, InvalidOTPException, UserSuspendedException } from '../exceptions';
import { createRateLimiter } from '../rate-limiter';
import { ActivityService } from './activity';
import { TFAService } from './tfa';
import {
	AbstractServiceOptions,
	Action,
	SchemaOverview,
	Session,
	User,
	DirectusTokenPayload,
	ShareData,
	LoginResult,
} from '../types';
import { Accountability } from '@directus/shared/types';
import { SettingsService } from './settings';
import { clone, cloneDeep } from 'lodash';
import { performance } from 'perf_hooks';
import { stall } from '../utils/stall';

const loginAttemptsLimiter = createRateLimiter({ duration: 0 });

export class AuthenticationService {
	knex: Knex;
	accountability: Accountability | null;
	activityService: ActivityService;
	schema: SchemaOverview;

	constructor(options: AbstractServiceOptions) {
		this.knex = options.knex || getDatabase();
		this.accountability = options.accountability || null;
		this.activityService = new ActivityService({ knex: this.knex, schema: options.schema });
		this.schema = options.schema;
	}

	/**
	 * Retrieve the tokens for a given user email.
	 *
	 * Password is optional to allow usage of this function within the SSO flow and extensions. Make sure
	 * to handle password existence checks elsewhere
	 */
	async login(
		providerName: string = DEFAULT_AUTH_PROVIDER,
		payload: Record<string, any>,
		otp?: string
	): Promise<LoginResult> {
		const STALL_TIME = 100;
		const timeStart = performance.now();

		const provider = getAuthProvider(providerName);

		const user = await this.knex
			.select<User & { tfa_secret: string | null }>(
				'u.id',
				'u.first_name',
				'u.last_name',
				'u.email',
				'u.password',
				'u.status',
				'u.role',
				'r.admin_access',
				'r.app_access',
				'u.tfa_secret',
				'u.provider',
				'u.external_identifier',
				'u.auth_data'
			)
			.from('directus_users as u')
			.innerJoin('directus_roles as r', 'u.role', 'r.id')
			.where('u.id', await provider.getUserID(cloneDeep(payload)))
			.andWhere('u.provider', providerName)
			.first();

		const updatedPayload = await emitter.emitFilter(
			'auth.login',
			payload,
			{
				status: 'pending',
				user: user?.id,
				provider: providerName,
			},
			{
				database: this.knex,
				schema: this.schema,
				accountability: this.accountability,
			}
		);

		const emitStatus = (status: 'fail' | 'success') => {
			emitter.emitAction(
				'auth.login',
				{
					payload: updatedPayload,
					status,
					user: user?.id,
					provider: providerName,
				},
				{
					database: this.knex,
					schema: this.schema,
					accountability: this.accountability,
				}
			);
		};

		if (user?.status !== 'active') {
			emitStatus('fail');

			if (user?.status === 'suspended') {
				await stall(STALL_TIME, timeStart);
				throw new UserSuspendedException();
			} else {
				await stall(STALL_TIME, timeStart);
				throw new InvalidCredentialsException();
			}
		}

		const settingsService = new SettingsService({
			knex: this.knex,
			schema: this.schema,
		});

		const { auth_login_attempts: allowedAttempts } = await settingsService.readSingleton({
			fields: ['auth_login_attempts'],
		});

		if (allowedAttempts !== null) {
			loginAttemptsLimiter.points = allowedAttempts;

			try {
				await loginAttemptsLimiter.consume(user.id);
			} catch {
				await this.knex('directus_users').update({ status: 'suspended' }).where({ id: user.id });
				user.status = 'suspended';

				// This means that new attempts after the user has been re-activated will be accepted
				await loginAttemptsLimiter.set(user.id, 0, 0);
			}
		}

		try {
			await provider.login(clone(user), cloneDeep(updatedPayload));
		} catch (e) {
			emitStatus('fail');
			await stall(STALL_TIME, timeStart);
			throw e;
		}

		if (user.tfa_secret && !otp) {
			emitStatus('fail');
			await stall(STALL_TIME, timeStart);
			throw new InvalidOTPException(`"otp" is required`);
		}

		if (user.tfa_secret && otp) {
			const tfaService = new TFAService({ knex: this.knex, schema: this.schema });
			const otpValid = await tfaService.verifyOTP(user.id, otp);

			if (otpValid === false) {
				emitStatus('fail');
				await stall(STALL_TIME, timeStart);
				throw new InvalidOTPException(`"otp" is invalid`);
			}
		}

		const tokenPayload = {
			id: user.id,
			role: user.role,
			app_access: user.app_access,
			admin_access: user.admin_access,
		};

		const customClaims = await emitter.emitFilter(
			'auth.jwt',
			tokenPayload,
			{
				status: 'pending',
				user: user?.id,
				provider: providerName,
				type: 'login',
			},
			{
				database: this.knex,
				schema: this.schema,
				accountability: this.accountability,
			}
		);

		const accessToken = jwt.sign(customClaims, env.SECRET as string, {
			expiresIn: env.ACCESS_TOKEN_TTL,
			issuer: 'directus',
		});

		const refreshToken = nanoid(64);
		const refreshTokenExpiration = new Date(Date.now() + ms(env.REFRESH_TOKEN_TTL as string));

		await this.knex('directus_sessions').insert({
			token: refreshToken,
			user: user.id,
			expires: refreshTokenExpiration,
			ip: this.accountability?.ip,
			user_agent: this.accountability?.userAgent,
		});

		await this.knex('directus_sessions').delete().where('expires', '<', new Date());

		if (this.accountability) {
			await this.activityService.createOne({
				action: Action.LOGIN,
				user: user.id,
				ip: this.accountability.ip,
				user_agent: this.accountability.userAgent,
				collection: 'directus_users',
				item: user.id,
			});
		}

		await this.knex('directus_users').update({ last_access: new Date() }).where({ id: user.id });

		emitStatus('success');

		if (allowedAttempts !== null) {
			await loginAttemptsLimiter.set(user.id, 0, 0);
		}

		await stall(STALL_TIME, timeStart);

		return {
			accessToken,
			refreshToken,
			expires: ms(env.ACCESS_TOKEN_TTL as string),
			id: user.id,
		};
	}

	async refresh(refreshToken: string): Promise<Record<string, any>> {
		if (!refreshToken) {
			throw new InvalidCredentialsException();
		}

		const record = await this.knex
			.select({
				session_expires: 's.expires',
				user_id: 'u.id',
				user_first_name: 'u.first_name',
				user_last_name: 'u.last_name',
				user_email: 'u.email',
				user_password: 'u.password',
				user_status: 'u.status',
				user_provider: 'u.provider',
				user_external_identifier: 'u.external_identifier',
				user_auth_data: 'u.auth_data',
				role_id: 'r.id',
				role_admin_access: 'r.admin_access',
				role_app_access: 'r.app_access',
				share_id: 'd.id',
				share_item: 'd.item',
				share_collection: 'd.collection',
				share_expires: 'd.date_expired',
				share_times_used: 'd.times_used',
				share_max_uses: 'd.max_uses',
			})
			.from('directus_sessions AS s')
			.leftJoin('directus_users AS u', 's.user', 'u.id')
			.leftJoin('directus_shares AS d', 's.share', 'd.id')
			.joinRaw('LEFT JOIN directus_roles AS r ON r.id IN (u.role, d.role)')
			.where('s.token', refreshToken)
			.andWhere('s.expires', '>=', this.knex.fn.now())
			.andWhere((subQuery) => {
				subQuery.whereNull('d.date_expired').orWhere('d.date_expired', '>=', this.knex.fn.now());
			})
			.first();

		if (!record || (!record.share_id && !record.user_id)) {
			throw new InvalidCredentialsException();
		}

		if (record.user_id) {
			const provider = getAuthProvider(record.user_provider);

			await provider.refresh({
				id: record.user_id,
				first_name: record.user_first_name,
				last_name: record.user_last_name,
				email: record.user_email,
				password: record.user_password,
				status: record.user_status,
				provider: record.user_provider,
				external_identifier: record.user_external_identifier,
				auth_data: record.user_auth_data,
				role: record.role_id,
				app_access: record.role_app_access,
				admin_access: record.role_admin_access,
			});
		}

		const tokenPayload: DirectusTokenPayload = {
			id: record.user_id,
			role: record.role_id,
			app_access: record.role_app_access,
			admin_access: record.role_admin_access,
		};

		if (record.share_id) {
			tokenPayload.role = record.share_role;
			tokenPayload.share_scope = {
				collection: record.share_collection,
				item: record.share_item,
			};
		}

		const customClaims = await emitter.emitFilter(
			'auth.jwt',
			tokenPayload,
			{
				status: 'pending',
				user: record.user_id,
				provider: record.user_provider,
				type: 'refresh',
			},
			{
				database: this.knex,
				schema: this.schema,
				accountability: this.accountability,
			}
		);

		const accessToken = jwt.sign(customClaims, env.SECRET as string, {
			expiresIn: env.ACCESS_TOKEN_TTL,
			issuer: 'directus',
		});

		const newRefreshToken = nanoid(64);
		const refreshTokenExpiration = new Date(Date.now() + ms(env.REFRESH_TOKEN_TTL as string));

		await this.knex('directus_sessions')
			.update({
				token: newRefreshToken,
				expires: refreshTokenExpiration,
			})
			.where({ token: refreshToken });

		if (record.user_id) {
			await this.knex('directus_users').update({ last_access: new Date() }).where({ id: record.user_id });
		}

		return {
			accessToken,
			refreshToken: newRefreshToken,
			expires: ms(env.ACCESS_TOKEN_TTL as string),
			id: record.user_id,
		};
	}

	async logout(refreshToken: string): Promise<void> {
		const record = await this.knex
			.select<User & Session>(
				'u.id',
				'u.first_name',
				'u.last_name',
				'u.email',
				'u.password',
				'u.status',
				'u.role',
				'u.provider',
				'u.external_identifier',
				'u.auth_data'
			)
			.from('directus_sessions as s')
			.innerJoin('directus_users as u', 's.user', 'u.id')
			.where('s.token', refreshToken)
			.first();

		if (record) {
			const user = record;

			const provider = getAuthProvider(user.provider);
			await provider.logout(clone(user));

			await this.knex.delete().from('directus_sessions').where('token', refreshToken);
		}
	}

	async verifyPassword(userID: string, password: string): Promise<void> {
		const user = await this.knex
			.select<User>(
				'id',
				'first_name',
				'last_name',
				'email',
				'password',
				'status',
				'role',
				'provider',
				'external_identifier',
				'auth_data'
			)
			.from('directus_users')
			.where('id', userID)
			.first();

		if (!user) {
			throw new InvalidCredentialsException();
		}

		const provider = getAuthProvider(user.provider);
		await provider.verify(clone(user), password);
	}
}
