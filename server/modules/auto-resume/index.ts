// initializeAutoResume: called by the server composition root at startup to
// recover interrupted resumes and connect the chat run registry.
// dispatchDueAutoResumes: run by the scheduled-messages dispatcher on its poll.
// cancelPendingAutoResume / cancelAllPendingAutoResumes / getAutoResumeStatus:
// for the auto-resume routes. recordUsageLimitHit / attemptResume: exported for
// the module's tests.
export {
  attemptResume,
  cancelAllPendingAutoResumes,
  cancelPendingAutoResume,
  dispatchDueAutoResumes,
  getAutoResumeStatus,
  initializeAutoResume,
  recordUsageLimitHit,
} from './services/auto-resume.service.js';
