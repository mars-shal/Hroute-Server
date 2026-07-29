import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  SignUpEmail,
  LoginValidator,
  UpdatePassword,
  UploadModel,
  ApiResponse,
} from './model.js';

import { log, logger } from '../utils/logger.js';

// In the Python version, @authVerify wraps methods to inject
// `claims = {"sub": user.id}` after verifying the JWT token.
// TypeScript doesn't have stable method decorators without
// experimental flags, so we use a straight-forward helper instead.

interface AuthClaims {
  sub: string;
}

class Database {
  private supabase_url: string;
  private supabase_key: string;
  private supabase: SupabaseClient;

  constructor() {
    this.supabase_url = process.env.SUPABASE_URL ?? '';
    // Use service_role key to bypass RLS — all operations are server-side.
    // SUPABASE_KEY (anon) is available for client-facing auth if needed later.
    this.supabase_key = process.env.SUPABASE_SECRET_KEY ?? '';

    if (!this.supabase_url || !this.supabase_key) {
      throw new Error(
        'SUPABASE_URL and SUPABASE_SECRET_KEY must be set in environment variables.'
      );
    }

    this.supabase = createClient(this.supabase_url, this.supabase_key);
  }

  private async verifyToken(token: string): Promise<AuthClaims | null> {
    try {
      if (!token) {
        logger.warn('[AuthVerify] No token provided');
        return null;
      }
      logger.info(`[AuthVerify] Verifying token: ${token.slice(0, 20)}...`);
      const { data, error } = await this.supabase.auth.getUser(token);
      if (error || !data?.user) {
        logger.warn(`[AuthVerify] Verification failed: ${error?.message ?? 'No user'}`);
        return null;
      }
      logger.info(`[AuthVerify] user.id=${data.user.id}`);
      return { sub: data.user.id };
    } catch (e) {
      logger.error(`[AuthVerify] Error: ${e}`);
      return null;
    }
  }

  async authenticateToken(token: string): Promise<ApiResponse & { userId?: string }> {
    const claims = await this.verifyToken(token);
    if (!claims) {
      return { status: 401, response: 'Invalid token' };
    }

    return { status: 200, userId: claims.sub };
  }

  // ── File storage ──────────────────────────────────────────────

  async getFile(token: string, folder: string, fileName: string): Promise<ApiResponse> {
    const claims = await this.verifyToken(token);
    if (!claims) return { success: false, response: 'Invalid token', status: 401 };

    try {
      const userId = claims.sub;
      const { data, error } = await this.supabase.storage
        .from('user-data')
        .createSignedUrl(`${userId}/${folder}/${fileName}`, 60);

      if (error) throw error;
      return data as unknown as ApiResponse;
    } catch (e) {
      logger.error(`[getFile] Error: ${e}`);
      return { response: String(e), status: 401 };
    }
  }

  async listFiles(token: string, folder: string): Promise<ApiResponse> {
    const claims = await this.verifyToken(token);
    if (!claims) return { success: false, response: 'Invalid token', status: 401 };

    try {
      const userId = claims.sub;
      const { data, error } = await this.supabase.storage
        .from('user-data')
        .list(`${userId}/${folder}/`);

      if (error) throw error;
      return { status: 200, data };
    } catch (e) {
      logger.error(`[listFiles] Error: ${e}`);
      return { response: String(e), status: 401 };
    }
  }

  async uploadFile(token: string, payload: UploadModel): Promise<ApiResponse> {
    const claims = await this.verifyToken(token);
    if (!claims) return { success: false, response: 'Invalid token', status: 401 };

    try {
      const userId = claims.sub;
      if (!userId) return { status: 401, response: 'User ID not found' };

      const fileBytes = Buffer.from(payload.fileData, 'base64');
      const filePath = `${userId}/${payload.filePath}/${payload.fileName}`;

      logger.info(`[uploadFile] Uploading ${filePath} (${fileBytes.length} bytes)`);
      const { error } = await this.supabase.storage
        .from('user-data')
        .upload(filePath, fileBytes, {
          contentType: payload.contentType,
          upsert: true,
        });

      if (error) throw error;

      logger.info(`[uploadFile] Uploaded ${filePath}`);
      await log(`[uploadFile] success: ${filePath}`);
      return {
        status: 200,
        response: 'File uploaded successfully',
        payload,
      };
    } catch (e) {
      logger.error(`[uploadFile] Error: ${e}`);
      await log(`[uploadFile] ERROR: ${e}`);
      return { status: 500, response: String(e) };
    }
  }

  async deleteFile(fileName: string): Promise<ApiResponse> {
    try {
      const { error } = await this.supabase.storage
        .from('user-data')
        .remove([fileName]);

      if (error) throw error;
      return { status: 200, message: 'File deleted from storage' };
    } catch (e) {
      logger.error(`[deleteFile] Error: ${e}`);
      return { response: String(e), status: 500 };
    }
  }

  async uploadResumeFile(token: string, buffer: Uint8Array, fileType: string): Promise<ApiResponse> {
    const claims = await this.verifyToken(token);
    if (!claims) return { success: false, response: 'Invalid token', status: 401 };

    try {
      const userId = claims.sub;
      if (!userId) return { status: 401, response: 'User ID not found' };

      const fileName = `resume.${fileType === 'pdf' ? 'pdf' : 'txt'}`;
      const filePath = `${userId}/resumes/${fileName}`;
      const contentType = fileName.endsWith('.pdf') ? 'application/pdf' : 'text/plain';
      logger.info(`[uploadResumeFile] Uploading ${filePath} (${buffer.length} bytes)`);

      const { error } = await this.supabase.storage
        .from('user-data')
        .upload(filePath, buffer, { contentType, upsert: true });

      if (error) throw error;

      logger.info(`[uploadResumeFile] Uploaded ${filePath}`);
      await log(`[uploadResumeFile] success: ${filePath}`);
      return { status: 200 };
    } catch (e) {
      logger.error(`[uploadResumeFile] Error: ${e}`);
      await log(`[uploadResumeFile] ERROR: ${e}`);
      return { status: 500, response: String(e) };
    }
  }

  async getResumeSignedUrl(token: string): Promise<ApiResponse & { url?: string }> {
    const claims = await this.verifyToken(token);
    if (!claims) return { success: false, response: 'Invalid token', status: 401 };

    try {
      const userId = claims.sub;
      if (!userId) return { status: 401, response: 'User ID not found' };

      const { data: profile, error: profileError } = await this.supabase
        .from('profiles')
        .select('resume_file_type')
        .eq('id', userId)
        .maybeSingle();

      if (profileError) throw profileError;

      const fileType = profile?.resume_file_type;
      if (typeof fileType !== 'string' || (fileType !== 'pdf' && fileType !== 'txt')) {
        return { status: 404, response: 'Resume file not found' };
      }

      const filePath = `${userId}/resumes/resume.${fileType}`;
      const { data, error } = await this.supabase.storage
        .from('user-data')
        .createSignedUrl(filePath, 3600);

      if (error) throw error;
      return { status: 200, url: data.signedUrl };
    } catch (e) {
      logger.error(`[getResumeSignedUrl] Error: ${e}`);
      return { status: 500, response: String(e) };
    }
  }

  async getGeneratedResumeUrl(token: string): Promise<ApiResponse & { url?: string }> {
    const claims = await this.verifyToken(token);
    if (!claims) return { success: false, response: 'Invalid token', status: 401 };

    try {
      const userId = claims.sub;
      if (!userId) return { status: 401, response: 'User ID not found' };

      const filePath = `${userId}/generated/resume.pdf`;
      const { data, error } = await this.supabase.storage
        .from('user-data')
        .createSignedUrl(filePath, 3600);

      if (error) throw error;
      return { status: 200, url: data.signedUrl };
    } catch (e) {
      logger.error(`[getGeneratedResumeUrl] Error: ${e}`);
      return { status: 500, response: String(e) };
    }
  }

  // ── Generic CRUD ──────────────────────────────────────────────

  async getData(token: string, table: string): Promise<ApiResponse> {
    const claims = await this.verifyToken(token);
    if (!claims) return { success: false, response: 'Invalid token', status: 401 };

    try {
      const userId = claims.sub;
      const { data, error } = await this.supabase
        .from(table)
        .select('*')
        .eq('id', userId)
        .maybeSingle();

      if (error) throw error;
      return { status: 200, data };
    } catch (e) {
      logger.error(`[getData] Error: ${e}`);
      return { response: String(e), status: 401 };
    }
  }

  async insertData(token: string, table: string, data: Record<string, unknown>): Promise<ApiResponse> {
    const claims = await this.verifyToken(token);
    if (!claims) return { success: false, response: 'Invalid token', status: 401 };

    try {
      const userId = claims.sub;
      if (!data || !userId) {
        return { response: 'Data or User ID not provided', status: 404 };
      }

      const { error } = await this.supabase
        .from(table)
        .upsert({ id: userId, ...data });

      if (error) throw error;
      return { status: 200 };
    } catch (e) {
      logger.error(`[insertData] Error: ${e}`);
      return { response: String(e), status: 401 };
    }
  }

  // ── Auth ──────────────────────────────────────────────────────

  async createUser(data: SignUpEmail): Promise<ApiResponse> {
    try {
      logger.info(`[createUser] Signing up ${data.email}`);
      const { data: response, error } = await this.supabase.auth.signUp({
        email: data.email,
        password: data.password,
      });

      if (error) throw error;

      if (response.session) {
        const access_token = response.session.access_token;
        const refresh_token = response.session.refresh_token;
        const user_id = response.user?.id ?? null;

        if (user_id) {
          const { error: profileErr } = await this.supabase
            .from('profiles')
            .upsert({ id: user_id })
            .maybeSingle();

          if (profileErr) {
            logger.error(`[createUser] Profile creation error: ${profileErr.message}`);
          }
        }

        logger.info(`[createUser] User created: ${data.email} (id=${user_id})`);
        await log(`[createUser] success: ${data.email}`);
        return { access_token, refresh_token };
      }

      logger.warn(`[createUser] No session returned for ${data.email}`);
      return { response: 'No session returned', status: 400 };
    } catch (e) {
      const msg = String(e);
      logger.error(`[createUser] Error: ${msg}`);
      await log(`[createUser] ERROR: ${data.email} — ${msg}`);

      if (msg.toLowerCase().includes('already exists') || msg.toLowerCase().includes('already registered')) {
        return { success: false, response: 'User already exists', status: 409 };
      }

      return { success: false, response: msg, status: 400 };
    }
  }

  async loginUser(data: LoginValidator): Promise<ApiResponse> {
    try {
      logger.info(`[loginUser] Logging in ${data.email}`);
      const { data: response, error } = await this.supabase.auth.signInWithPassword({
        email: data.email,
        password: data.password,
      });

      if (error) throw error;

      if (response.session) {
        logger.info(`[loginUser] Login success: ${data.email}`);
        await log(`[loginUser] success: ${data.email}`);
        return {
          access_token: response.session.access_token,
          refresh_token: response.session.refresh_token,
        };
      }

      logger.warn(`[loginUser] No session for ${data.email}`);
      return { response: 'No session returned', status: 400 };
    } catch (e) {
      logger.error(`[loginUser] Error: ${e}`);
      await log(`[loginUser] ERROR: ${data.email} — ${e}`);
      return { status: 400, response: String(e) };
    }
  }

  async refreshToken(refresh_token: string): Promise<ApiResponse> {
    try {
      logger.info('[refreshToken] Attempting token refresh...');
      const { data, error } = await this.supabase.auth.refreshSession({ refresh_token });

      if (error) throw error;

      if (data.session) {
        logger.info('[refreshToken] Token refresh successful');
        return {
          access_token: data.session.access_token,
          expires_in: data.session.expires_in ?? 86400,
        };
      }

      logger.warn('[refreshToken] No session in response');
      return { status: 401, error: 'Invalid session response' };
    } catch (e) {
      const msg = String(e);
      logger.error(`[refreshToken] Error: ${msg}`);

      if (msg.toLowerCase().includes('refresh_token') || msg.toLowerCase().includes('invalid')) {
        return { status: 401, error: 'Invalid or expired refresh token' };
      }
      return { status: 500, error: msg };
    }
  }

  async logout(): Promise<ApiResponse> {
    try {
      const { error } = await this.supabase.auth.signOut();
      if (error) throw error;
      return { status: 200, message: 'Logged out successfully' };
    } catch (e) {
      logger.error(`[logout] Error: ${e}`);
      return { error: String(e), status: 500 };
    }
  }

  async getUser(token: string): Promise<ApiResponse> {
    const claims = await this.verifyToken(token);
    if (!claims) return { success: false, response: 'Invalid token', status: 401 };

    try {
      const userId = claims.sub;

      const { data: authUser, error: authError } = await this.supabase.auth.getUser(token);
      if (authError) throw authError;

      const { data: profile, error: profileError } = await this.supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

      if (profileError && profileError.code !== 'PGRST116') {
        throw profileError;
      }

      const profileData = (profile ?? {}) as Record<string, unknown>;

      return {
        id: userId,
        email: authUser?.user?.email ?? null,
        display_name: profileData.display_name ?? null,
        avatar_url: profileData.avatar_url ?? null,
        timezone: profileData.timezone ?? null,
        headline: profileData.headline ?? null,
        location: profileData.location ?? null,
        role: profileData.role ?? null,
        work_style: profileData.work_style ?? null,
        work_style_hint: profileData.work_style_hint ?? null,
        experience: profileData.experience ?? null,
        experience_hint: profileData.experience_hint ?? null,
        salary_target: profileData.salary_target ?? null,
        skills: profileData.skills ?? null,
        resume_text: profileData.resume_text ?? null,
        resume_file_type: profileData.resume_file_type ?? null,
        resume_version: profileData.resume_version ?? null,
        created_at: profileData.created_at ?? null,
        resume_score: profileData.resume_score ?? null,
        status: 200,
      };
    } catch (e) {
      logger.error(`[getUser] Error: ${e}`);
      return { status: 400, response: String(e) };
    }
  }

  async updateUser(token: string, payload: Record<string, unknown>): Promise<ApiResponse> {
    const claims = await this.verifyToken(token);
    if (!claims) return { success: false, response: 'Invalid token', status: 401 };

    try {
      const userId = claims.sub;

      const { error } = await this.supabase
        .from('profiles')
        .upsert({ id: userId, ...payload });

      if (error) throw error;
      return { status: 200 };
    } catch (e) {
      const msg = e instanceof Error ? e.message : typeof e === 'object' ? JSON.stringify(e) : String(e);
      logger.error(`[updateUser] Error: ${msg}`);

      if (msg.toLowerCase().includes('column') && msg.toLowerCase().includes('does not exist')) {
        return { response: `Database column missing: ${msg}`, status: 500 };
      }
      return { response: msg, status: 400 };
    }
  }

  async updateUserPassword(token: string, payload: UpdatePassword): Promise<ApiResponse> {
    const claims = await this.verifyToken(token);
    if (!claims) return { success: false, response: 'Invalid token', status: 401 };

    try {
      const userId = claims.sub;

      const { data: userData, error: userError } = await this.supabase.auth.getUser(token);
      if (userError) throw userError;
      const email = userData?.user?.email;
      if (!email) return { response: 'User not found', status: 404 };

      const { error: verifyError } = await this.supabase.auth.signInWithPassword({
        email,
        password: payload.current_password,
      });
      if (verifyError) {
        return { response: 'Current password is incorrect', status: 400 };
      }

      const { error: updateError } = await this.supabase.auth.admin.updateUserById(
        userId,
        { password: payload.new_password }
      );
      if (updateError) throw updateError;

      return { status: 200, message: 'Password updated successfully' };
    } catch (e) {
      logger.error(`[updateUserPassword] Error: ${e}`);
      return { response: String(e), status: 500 };
    }
  }

  async deleteUser(token: string): Promise<ApiResponse> {
    const claims = await this.verifyToken(token);
    if (!claims) return { success: false, response: 'Invalid token', status: 401 };

    try {
      const userId = claims.sub;

      const { error: profileError } = await this.supabase
        .from('profiles')
        .delete()
        .eq('id', userId);
      if (profileError) throw profileError;

      const { error: authError } = await this.supabase.auth.admin.deleteUser(userId);
      if (authError) throw authError;

      return { status: 200, message: 'Account deleted successfully' };
    } catch (e) {
      logger.error(`[deleteUser] Error: ${e}`);
      return { response: String(e), status: 500 };
    }
  }

  // ── Jobs ──────────────────────────────────────────────────────

  async storeJob(job: Record<string, unknown>): Promise<ApiResponse> {
    try {
      logger.info(`[storeJob] Storing job: title="${(job.title as string)?.slice(0, 60)}" source_url="${(job.source_url as string)?.slice(0, 80)}"`);
      const { data, error } = await this.supabase
        .from('jobs')
        .upsert(job, { onConflict: 'source_url', ignoreDuplicates: false })
        .select();

      if (error) throw error;
      logger.info(`[storeJob] Stored: ${JSON.stringify(data)}`);
      await log(`[storeJob] success: ${job.title} @ ${job.company}`);
      return { status: 200, data };
    } catch (e) {
      const msg = e instanceof Error ? e.message : typeof e === 'object' ? JSON.stringify(e) : String(e);
      logger.error(`[storeJob] Error: ${msg}`);
      await log(`[storeJob] ERROR: ${msg}`);
      return { response: msg, status: 500 };
    }
  }

  async storeJobVector(jobId: string, embedding: number[]): Promise<ApiResponse> {
    try {
      const { error } = await this.supabase
        .from('job_vectors')
        .upsert({ job_id: jobId, embedding }, { onConflict: 'job_id' });

      if (error) throw error;
      logger.info(`[storeJobVector] Stored vector for job ${jobId} (dim=${embedding.length})`);
      return { status: 200 };
    } catch (e) {
      logger.error(`[storeJobVector] Error: ${e}`);
      await log(`[storeJobVector] ERROR: ${e}`);
      return { response: String(e), status: 500 };
    }
  }

  async getRandomActiveJobs(limit: number = 50): Promise<ApiResponse> {
    try {
      const maxLimit = Math.min(limit, 50);
      // 60-day freshness window matching cleanup/discovery policy
      const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
      const fetchCount = Math.min(maxLimit * 5, 250);

      const { data, error } = await this.supabase
        .from('jobs')
        .select('*')
        .gte('crawled_at', cutoff)
        .order('crawled_at', { ascending: false })
        .limit(fetchCount);

      if (error) throw error;

      const candidates = data ?? [];
      for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
      }

      return { status: 200, data: candidates.slice(0, maxLimit) };
    } catch (e) {
      logger.error(`[getRandomActiveJobs] Error: ${e}`);
      return { response: String(e), status: 500 };
    }
  }

  async searchJobsByQuery(params: {
    query?: string;
    location?: string;
    remote?: boolean;
    skills?: string[];
    limit?: number;
  } = {}): Promise<ApiResponse> {
    try {
      // Default freshness: 60-day window matching cleanup policy
      const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
      const maxLimit = Math.min(params.limit ?? 50, 50);

      let query = this.supabase
        .from('jobs')
        .select('*')
        .gte('crawled_at', cutoff);

      if (params.query) {
        const term = params.query.trim();
        query = query.or(
          `title.ilike.%${term}%,company.ilike.%${term}%,description.ilike.%${term}%`,
        );
      }
      if (params.location) {
        query = query.ilike('location', `%${params.location.trim()}%`);
      }
      if (params.remote === true) {
        query = query.eq('remote_status', 'remote');
      }
      if (Array.isArray(params.skills) && params.skills.length > 0) {
        query = query.overlaps('skills', params.skills);
      }

      const { data, error } = await query
        .order('crawled_at', { ascending: false })
        .limit(maxLimit);

      if (error) throw error;
      return { status: 200, data: data ?? [] };
    } catch (e) {
      logger.error(`[searchJobsByQuery] Error: ${e}`);
      return { response: String(e), status: 500 };
    }
  }

  async getJobsRecent(limit: number = 50): Promise<ApiResponse> {
    try {
      const { data, error } = await this.supabase
        .from('jobs')
        .select('*')
        .order('crawled_at', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return { status: 200, data: data ?? [] };
    } catch (e) {
      logger.error(`[getJobsRecent] Error: ${e}`);
      return { response: String(e), status: 500 };
    }
  }

  async getJobBySourceUrl(sourceUrl: string): Promise<ApiResponse> {
    try {
      const { data, error } = await this.supabase
        .from('jobs')
        .select('*')
        .eq('source_url', sourceUrl)
        .maybeSingle();

      if (error) throw error;
      if (!data) return { response: 'Job not found', status: 404 };
      return { status: 200, data };
    } catch (e) {
      logger.error(`[getJobBySourceUrl] Error: ${e}`);
      return { response: String(e), status: 500 };
    }
  }

  async listJobsForCleanup(limit: number = 1000): Promise<ApiResponse> {
    try {
      const { data, error } = await this.supabase
        .from('jobs')
        .select('id,title,description,skills,remote_status,apply_url,source_url,posted_date,company,source_site,experience_level')
        .order('crawled_at', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return { status: 200, data: data ?? [] };
    } catch (e) {
      logger.error(`[listJobsForCleanup] Error: ${e}`);
      return { response: String(e), status: 500 };
    }
  }

  async updateJobById(jobId: string, patch: Record<string, unknown>): Promise<ApiResponse> {
    try {
      const { data, error } = await this.supabase
        .from('jobs')
        .update(patch)
        .eq('id', jobId)
        .select('id')
        .maybeSingle();

      if (error) throw error;
      return { status: 200, data };
    } catch (e) {
      logger.error(`[updateJobById] Error: ${e}`);
      return { response: String(e), status: 500 };
    }
  }

  async deleteJobVector(jobId: string): Promise<ApiResponse> {
    try {
      const { error } = await this.supabase
        .from('job_vectors')
        .delete()
        .eq('job_id', jobId);

      if (error) throw error;
      return { status: 200 };
    } catch (e) {
      logger.error(`[deleteJobVector] Error: ${e}`);
      return { response: String(e), status: 500 };
    }
  }

  async deleteJobById(jobId: string): Promise<ApiResponse> {
    try {
      const { error } = await this.supabase
        .from('jobs')
        .delete()
        .eq('id', jobId);

      if (error) throw error;
      return { status: 200 };
    } catch (e) {
      logger.error(`[deleteJobById] Error: ${e}`);
      return { response: String(e), status: 500 };
    }
  }

  async searchJobsByEmbedding(
    embedding: number[],
    matchThreshold: number = 0.5,
    matchCount: number = 20,
  ): Promise<ApiResponse> {
    try {
      logger.info(`[searchJobsByEmbedding] threshold=${matchThreshold} count=${matchCount}`);
      const { data, error } = await this.supabase.rpc('match_jobs', {
        query_embedding: embedding,
        match_threshold: matchThreshold,
        match_count: matchCount,
      });

      if (error) throw error;
      const results = (data ?? []) as unknown[];
      logger.info(`[searchJobsByEmbedding] ${results.length} results`);
      return { status: 200, data: results };
    } catch (e) {
      logger.error(`[searchJobsByEmbedding] Error: ${e}`);
      await log(`[searchJobsByEmbedding] ERROR: ${e}`);
      return { response: String(e), status: 500 };
    }
  }

  // ── Applications ─────────────────────────────────────────────

  async saveApplication(token: string, jobId: string): Promise<ApiResponse> {
    const claims = await this.verifyToken(token);
    if (!claims) return { success: false, response: 'Invalid token', status: 401 };

    try {
      const userId = claims.sub;
      logger.info(`[saveApplication] Saving job ${jobId} for user ${userId}`);
      const { data, error } = await this.supabase
        .from('applications')
        .upsert(
          { user_id: userId, job_id: jobId, status: 'saved' },
          { onConflict: 'user_id,job_id', ignoreDuplicates: false },
        )
        .select();

      if (error) throw error;
      logger.info(`[saveApplication] Saved job ${jobId}`);
      await log(`[saveApplication] user=${userId} job=${jobId}`);
      return { status: 200, data };
    } catch (e) {
      logger.error(`[saveApplication] Error: ${e}`);
      await log(`[saveApplication] ERROR: ${e}`);
      return { response: String(e), status: 500 };
    }
  }

  async updateApplicationStatus(token: string, applicationId: string, status: string): Promise<ApiResponse> {
    const claims = await this.verifyToken(token);
    if (!claims) return { success: false, response: 'Invalid token', status: 401 };

    try {
      const userId = claims.sub;
      const { data, error } = await this.supabase
        .from('applications')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('id', applicationId)
        .eq('user_id', userId)
        .select();

      if (error) throw error;
      return { status: 200, data };
    } catch (e) {
      logger.error(`[updateApplicationStatus] Error: ${e}`);
      return { response: String(e), status: 500 };
    }
  }

  async getApplications(token: string, statusFilter?: string | null): Promise<ApiResponse> {
    const claims = await this.verifyToken(token);
    if (!claims) return { success: false, response: 'Invalid token', status: 401 };

    try {
      const userId = claims.sub;
      let query = this.supabase
        .from('applications')
        .select('*, jobs(*)')
        .eq('user_id', userId);

      if (statusFilter) {
        query = query.eq('status', statusFilter);
      }

      const { data, error } = await query.order('created_at', { ascending: false });

      if (error) throw error;
      return { status: 200, data: data ?? [] };
    } catch (e) {
      logger.error(`[getApplications] Error: ${e}`);
      return { response: String(e), status: 500 };
    }
  }

  async deleteApplication(token: string, applicationId: string): Promise<ApiResponse> {
    const claims = await this.verifyToken(token);
    if (!claims) return { success: false, response: 'Invalid token', status: 401 };

    try {
      const userId = claims.sub;
      const { error } = await this.supabase
        .from('applications')
        .delete()
        .eq('id', applicationId)
        .eq('user_id', userId);

      if (error) throw error;
      return { status: 200, message: 'Application deleted' };
    } catch (e) {
      logger.error(`[deleteApplication] Error: ${e}`);
      return { response: String(e), status: 500 };
    }
  }

  // ── Resume ────────────────────────────────────────────────────

  async saveResumeEmbedding(token: string, embedding: number[]): Promise<ApiResponse> {
    const claims = await this.verifyToken(token);
    if (!claims) return { success: false, response: 'Invalid token', status: 401 };

    try {
      const userId = claims.sub;
      const resumeVersion = new Date().toISOString();
      logger.info(`[saveResumeEmbedding] Saving for user ${userId} (dim=${embedding.length})`);
      const { error } = await this.supabase
        .from('profiles')
        .upsert({ id: userId, resume_embedding: embedding, resume_version: resumeVersion });

      if (error) throw error;
      logger.info(`[saveResumeEmbedding] Done for user ${userId}`);
      await log(`[saveResumeEmbedding] user=${userId}`);
      return { status: 200 };
    } catch (e) {
      logger.error(`[saveResumeEmbedding] Error: ${e}`);
      await log(`[saveResumeEmbedding] ERROR: ${e}`);
      return { response: String(e), status: 500 };
    }
  }

  async getResumeEmbedding(token: string): Promise<number[] | null> {
    const claims = await this.verifyToken(token);
    if (!claims) return null;

    try {
      const userId = claims.sub;
      const { data, error } = await this.supabase
        .from('profiles')
        .select('resume_embedding')
        .eq('id', userId)
        .maybeSingle();

      if (error) throw error;
      return (data?.resume_embedding as number[]) ?? null;
    } catch (e) {
      logger.error(`[getResumeEmbedding] Error: ${e}`);
      return null;
    }
  }
}

let dbInstance: Database | null = null;

export async function connectDatabase(): Promise<Database> {
  if (!dbInstance) {
    dbInstance = new Database();
  }
  return dbInstance;
}

export type DatabaseLike = Pick<
  Database,
  | "authenticateToken"
  | "getFile"
  | "listFiles"
  | "uploadFile"
  | "deleteFile"
  | "uploadResumeFile"
  | "getResumeSignedUrl"
  | "getGeneratedResumeUrl"
  | "getData"
  | "insertData"
  | "createUser"
  | "loginUser"
  | "refreshToken"
  | "logout"
  | "getUser"
  | "updateUser"
  | "updateUserPassword"
  | "deleteUser"
  | "storeJob"
  | "storeJobVector"
  | "getRandomActiveJobs"
  | "getJobsRecent"
  | "getJobBySourceUrl"
  | "listJobsForCleanup"
  | "updateJobById"
  | "deleteJobVector"
  | "deleteJobById"
  | "searchJobsByEmbedding"
  | "searchJobsByQuery"
  | "saveApplication"
  | "updateApplicationStatus"
  | "getApplications"
  | "deleteApplication"
  | "saveResumeEmbedding"
  | "getResumeEmbedding"
>;

export { Database };
export type { AuthClaims };
