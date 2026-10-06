import * as acp from '@agentclientprotocol/sdk';
import { z } from 'zod';
import { nextSeq, TELLS_MODEL } from '@g-code/core';
import { BackgroundJobs } from './background.js';
import { openSessionLog } from './chat.js';
import type { Io } from './command.js';
import { Inbox, loggedArrival } from './inbox.js';
import { backgroundUpdate } from './session-replay.js';
import { appendEvent, dropTornTail } from './sessions.js';
import type { Store } from './store.js';
import type { Tasks } from './tasks.js';
import type { Viewers } from './viewers.js';

/**
 * The engine's background commands, shared by every connection: each change goes to the step of the window that shows
 * the session and to the Tasks pane, and an end the model should hear of goes to the session's inbox.
 */
export function backgroundShared<P>(viewers: Viewers<P>, tasks: Tasks): { readonly jobs: BackgroundJobs; readonly inbox: Inbox } {
  const inbox = new Inbox();
  const jobs: BackgroundJobs = new BackgroundJobs({
    changed(job, view) {
      tasks.jobs(job.sessionId, jobs.running(job.sessionId));
      viewers.notify(job.sessionId, acp.methods.client.session.update, { sessionId: job.sessionId, update: backgroundUpdate(view) });
    },
    ended(end, job) {
      if (TELLS_MODEL(end.job.state)) inbox.put(job.sessionId, end);
    },
  });
  return { jobs, inbox };
}

/** Logs what reached a session while no turn ran, so the next turn's first request carries it. */
export async function logArrivals(store: Store, io: Io, inbox: Inbox, sessionId: string): Promise<void> {
  const arrivals = inbox.takeIdle(sessionId);
  if (arrivals.length === 0) return;
  const log = await openSessionLog(store, sessionId, io);
  await dropTornTail(log);
  let seq = nextSeq(log.events);
  for (const arrival of arrivals) await appendEvent(log.file, loggedArrival(arrival, seq++));
}

export const backgroundStopRequest = z.object({ sessionId: z.string(), id: z.string().min(1) });
