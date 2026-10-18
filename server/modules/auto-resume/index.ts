// The HTTP surface for the auto-continue setting and a session's resume status, mounted by the app.
export { default as autoResumeRoutes } from './auto-resume.routes.js';

// initializeAutoResume: called by the server composition root at startup to
// recover interrupted resumes and connect the chat run registry.
// dispatchDueAutoResumes: run by the scheduled-messages dispatcher on its poll.
// cancelPendingAutoResume / cancelAllPendingAutoResumes / dismissAutoResume /
// getAutoResumeStatus:
// for the auto-resume routes. recordUsageLimitHit / attemptResume: exported for
// the module's tests.
export {
  attemptResume,
  cancelAllPendingAutoResumes,
  cancelPendingAutoResume,
  dismissAutoResume,
  dispatchDueAutoResumes,
  getAutoResumeStatus,
  initializeAutoResume,
  recordUsageLimitHit,
} from './services/auto-resume.service.js';
