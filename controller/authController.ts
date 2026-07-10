import type { Database } from "../model/database";
import type { SignUpEmail, LoginValidator, UpdatePassword } from "../model/model";
import { log, logger } from "../utils/logger";

class AuthController {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async Register(data: SignUpEmail) {
    logger.info(`[Auth] Register entry: ${data.email}`);
    try {
      const result = await this.db.createUser(data);
      if (result.status === 409) {
        logger.warn(`[Auth] Register conflict: ${data.email}`);
        return { status: 409, error: "User already exists" };
      }
      if (result.access_token) {
        logger.info(`[Auth] Register success: ${data.email}`);
        await log(`[Auth] Register: ${data.email}`);
        return {
          status: 200,
          access_token: result.access_token,
          refresh_token: result.refresh_token,
        };
      }
      logger.warn(`[Auth] Register failed: ${data.email} — ${result.response}`);
      return { status: 400, error: result.response ?? "Registration failed" };
    } catch (e) {
      logger.error("[Auth] Register error:", e);
      await log(`[Auth] Register ERROR: ${e}`);
      return { status: 500, error: String(e) };
    }
  }

  async Login(data: LoginValidator) {
    logger.info(`[Auth] Login entry: ${data.email}`);
    try {
      const result = await this.db.loginUser(data);
      if (result.access_token) {
        logger.info(`[Auth] Login success: ${data.email}`);
        await log(`[Auth] Login: ${data.email}`);
        return {
          status: 200,
          access_token: result.access_token,
          refresh_token: result.refresh_token,
        };
      }
      logger.warn(`[Auth] Login failed: ${data.email}`);
      return { status: 401, error: result.response ?? "Invalid credentials" };
    } catch (e) {
      logger.error("[Auth] Login error:", e);
      await log(`[Auth] Login ERROR: ${e}`);
      return { status: 500, error: String(e) };
    }
  }

  async RefreshToken(refreshToken: string) {
    logger.info(`[Auth] RefreshToken entry (token=${refreshToken.slice(0, 12)}...)`);
    try {
      const result = await this.db.refreshToken(refreshToken);
      if (result.access_token) {
        logger.info(`[Auth] RefreshToken success`);
        await log(`[Auth] RefreshToken success`);
        return {
          status: 200,
          access_token: result.access_token,
          expires_in: result.expires_in,
        };
      }
      logger.warn(`[Auth] RefreshToken failed`);
      return { status: 401, error: result.error ?? "Token refresh failed" };
    } catch (e) {
      logger.error("[Auth] RefreshToken error:", e);
      await log(`[Auth] RefreshToken ERROR: ${e}`);
      return { status: 500, error: String(e) };
    }
  }

  async GetProfile(token: string) {
    logger.info(`[Auth] GetProfile entry (token=${token.slice(0, 12)}...)`);
    try {
      const result = await this.db.getUser(token);
      if (result.status === 200) {
        logger.info(`[Auth] GetProfile success: user=${result.id}`);
        return {
          status: 200,
          user: {
            id: result.id,
            email: result.email,
            display_name: result.display_name,
            avatar_url: result.avatar_url,
            timezone: result.timezone,
            headline: result.headline,
            location: result.location,
            role: result.role,
            work_style: result.work_style,
            work_style_hint: result.work_style_hint,
            experience: result.experience,
            experience_hint: result.experience_hint,
            salary_target: result.salary_target,
            skills: result.skills,
            resume_text: result.resume_text,
            resume_file_type: result.resume_file_type,
            resume_version: result.resume_version,
            created_at: result.created_at,
          },
        };
      }
      logger.warn(`[Auth] GetProfile invalid token`);
      return { status: 401, error: result.response ?? "Invalid token" };
    } catch (e) {
      logger.error("[Auth] GetProfile error:", e);
      return { status: 500, error: String(e) };
    }
  }

  async UpdateProfile(token: string, payload: Record<string, unknown>) {
    logger.info(`[Auth] UpdateProfile entry (token=${token.slice(0, 12)}... keys=${Object.keys(payload).join(',')})`);
    try {
      const result = await this.db.updateUser(token, payload);
      if (result.status === 200) {
        logger.info(`[Auth] UpdateProfile success`);
        await log(`[Auth] UpdateProfile: ${Object.keys(payload).join(',')}`);
        return { status: 200, message: "Profile updated" };
      }
      logger.warn(`[Auth] UpdateProfile failed: ${result.response}`);
      return { status: 400, error: result.response ?? "Update failed" };
    } catch (e) {
      logger.error("[Auth] UpdateProfile error:", e);
      return { status: 500, error: String(e) };
    }
  }

  async ChangePassword(token: string, payload: UpdatePassword) {
    logger.info(`[Auth] ChangePassword entry (token=${token.slice(0, 12)}...)`);
    try {
      const result = await this.db.updateUserPassword(token, payload);
      if (result.status === 200) {
        logger.info(`[Auth] ChangePassword success`);
        await log(`[Auth] ChangePassword success`);
        return { status: 200, message: "Password updated" };
      }
      logger.warn(`[Auth] ChangePassword failed: ${result.response}`);
      return {
        status: result.status ?? 400,
        error: result.response ?? "Password change failed",
      };
    } catch (e) {
      logger.error("[Auth] ChangePassword error:", e);
      await log(`[Auth] ChangePassword ERROR: ${e}`);
      return { status: 500, error: String(e) };
    }
  }

  async Logout(token: string) {
    logger.info(`[Auth] Logout entry (token=${token.slice(0, 12)}...)`);
    try {
      const result = await this.db.logout();
      if (result.status === 200) {
        logger.info(`[Auth] Logout success`);
        await log(`[Auth] Logout success`);
        return { status: 200, message: "Logged out" };
      }
      logger.warn(`[Auth] Logout failed: ${result.error}`);
      return { status: 500, error: result.error ?? "Logout failed" };
    } catch (e) {
      logger.error("[Auth] Logout error:", e);
      return { status: 500, error: String(e) };
    }
  }

  async DeleteAccount(token: string) {
    logger.info(`[Auth] DeleteAccount entry (token=${token.slice(0, 12)}...)`);
    try {
      const result = await this.db.deleteUser(token);
      if (result.status === 200) {
        logger.info(`[Auth] DeleteAccount success`);
        await log(`[Auth] DeleteAccount success`);
        return { status: 200, message: "Account deleted" };
      }
      logger.warn(`[Auth] DeleteAccount failed: ${result.response}`);
      return { status: 400, error: result.response ?? "Delete failed" };
    } catch (e) {
      logger.error("[Auth] DeleteAccount error:", e);
      await log(`[Auth] DeleteAccount ERROR: ${e}`);
      return { status: 500, error: String(e) };
    }
  }
}

export { AuthController };
