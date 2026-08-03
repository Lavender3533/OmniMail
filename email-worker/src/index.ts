import { fetchApi } from './api'
import { cleanup } from './cleanup'
import { consumeEmailQueue, receiveEmail } from './mail'
import { D1BlobStore } from './d1-blob-store'
import type { Env, MailQueueJob } from './types'

export { OmniMailBackupWorkflow } from './backup'
export { OmniMailCleanupWorkflow } from './cleanup-workflow'

async function fetchRequest(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
  const path = new URL(request.url).pathname
  return path === '/api' || path.startsWith('/api/')
    ? fetchApi(request, env, context)
    : env.ASSETS.fetch(request)
}

export default {
  fetch: (request: Request, env: Env, context: ExecutionContext) => {
    const e = wrapEnv(env)
    return fetchRequest(request, e, context)
  },
  email: (message: ForwardableEmailMessage, env: Env) => receiveEmail(message, wrapEnv(env)),
  queue: (batch: MessageBatch<MailQueueJob>, env: Env) => consumeEmailQueue(batch, wrapEnv(env)),
  scheduled: (_controller: ScheduledController, env: Env) => cleanup(wrapEnv(env)),
} satisfies ExportedHandler<Env, MailQueueJob>

/** Wrap env so MAIL_BUCKET always works, even without R2. */
function wrapEnv(env: Env): Env {
  if (!env.MAIL_BUCKET) {
    return { ...env, MAIL_BUCKET: new D1BlobStore({ db: env.DB }) as unknown as R2Bucket }
  }
  return env
}
