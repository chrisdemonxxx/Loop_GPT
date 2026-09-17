/** Compatibility entry points, deliberately retired. Historical MediaJob rows
 * have no accounting proof and must never be submitted or resumed. New prepaid
 * creation uses createAccountedVideoJob; execution is the separate video worker.
 * JWT creation remains disabled until daily job accounting is implemented.
 */
export interface CreateVideoJobInput {
  prompt: string; width: number; height: number; fps: number; numFrames: number
}
export async function createVideoJob(_userId: string, _input: CreateVideoJobInput): Promise<never> {
  throw new Error('Unaccounted video creation is unavailable')
}
export async function processVideoJob(_id: string, _signal?: AbortSignal): Promise<void> {}
export async function resumeMediaJobs(): Promise<void> {}
