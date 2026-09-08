/** @param {boolean} demo @returns {any} */
export function seed(demo = false) {
  const db = { version: 1, demo, users: [], authSessions: [], buyers: [], cohorts: [], enrollments: [], invitations: [], sessions: [], leads: [], subscribers: [], polls: [], documents: [], reports: [], surveys: [], invoices: [], contracts: [], notifications: [], messages: [], outbox: [], hooks: [], audit: [], reminders: [], settings: { timeZone: 'America/Chicago', startHour: 9, endHour: 17, weekdays: [1, 2, 3, 4, 5], reminderHours: 24, remindersEnabled: true }, createdAt: new Date().toISOString() };
  if (!demo) return db;
  const today = new Date();
  const day = (offset, hour = 15) => { const d = new Date(today); d.setUTCDate(d.getUTCDate() + offset); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };
  db.users = [
    { id: 'coach-demo', name: 'Carol Anthony', email: 'carol@demo.gocoach.test', role: 'coach', passwordHash: '' },
    { id: 'buyer-demo', name: 'Morgan Lee', email: 'morgan@northstar.example', role: 'buyer', buyerId: 'buyer-northstar', passwordHash: '' },
    { id: 'participant-demo', name: 'Alex Rivera', email: 'alex@northstar.example', role: 'participant', passwordHash: '' },
    { id: 'participant-jamie', name: 'Jamie Chen', email: 'jamie@northstar.example', role: 'participant', passwordHash: '' },
    { id: 'participant-sam', name: 'Sam Parker', email: 'sam@northstar.example', role: 'participant', passwordHash: '' },
    { id: 'buyer-other-user', name: 'Taylor Quinn', email: 'taylor@atlas.example', role: 'buyer', buyerId: 'buyer-atlas', passwordHash: '' },
  ];
  db.buyers = [
    { id: 'buyer-northstar', company: 'Northstar Labs', contact: 'Morgan Lee', email: 'morgan@northstar.example', billingEmail: 'accounts@northstar.example', billingAddress: '100 Example Avenue\nChicago, IL', notes: 'Illustrative local account.' },
    { id: 'buyer-atlas', company: 'Atlas & Co.', contact: 'Taylor Quinn', email: 'taylor@atlas.example', billingEmail: 'accounts@atlas.example', billingAddress: '200 Example Street', notes: 'Illustrative local account.' },
  ];
  db.cohorts = [
    { id: 'cohort-forward', name: 'Forward / Fall cohort', buyerId: 'buyer-northstar', startDate: day(-14), endDate: day(63), timeZone: 'America/Chicago', capacity: 7, price: 120000, status: 'active', description: 'A shared practice for managers navigating change.', createdAt: day(-30) },
    { id: 'cohort-next', name: 'The next chapter', buyerId: 'buyer-atlas', startDate: day(28), endDate: day(105), timeZone: 'America/Chicago', capacity: 6, price: 120000, status: 'enrolling', description: 'Six leaders. A new direction. Twelve weeks of practice.', createdAt: day(-3) },
  ];
  db.enrollments = [
    { id: 'enroll-alex', cohortId: 'cohort-forward', userId: 'participant-demo', status: 'enrolled' },
    { id: 'enroll-jamie', cohortId: 'cohort-forward', userId: 'participant-jamie', status: 'enrolled' },
    { id: 'enroll-sam', cohortId: 'cohort-forward', userId: 'participant-sam', status: 'invited' },
  ];
  const titles = ['Baseline', 'The interior work', 'Under pressure', 'Across', 'Who stays', 'Integration'];
  db.sessions = titles.map((title, index) => ({ id: `session-${index + 1}`, cohortId: 'cohort-forward', title, startsAt: day(index === 0 ? -14 : 1 + (index - 1) * 14), duration: 90, status: index === 0 ? 'completed' : 'scheduled', kind: 'cohort', meetingUrl: '', materials: index === 1 ? 'Bring a real conversation you have been avoiding. Note what makes it difficult and what a useful outcome would look like.' : '', summary: index === 0 ? 'We established the cohort agreement and each participant’s focus for the program. Continue observing one recurring pattern before the next session.' : '', privateNotes: index === 0 ? 'Sample coach-only note. Keep the next session focused on concrete situations.' : '' }));
  db.leads = [
    { id: 'lead-one', name: 'Jordan Ellis', email: 'jordan@meridian.example', company: 'Meridian Studio', stage: 'discovery', value: 720000, note: 'Exploring a cohort for emerging managers.', createdAt: day(-2) },
    { id: 'lead-two', name: 'Taylor Quinn', email: 'taylor@atlas.example', company: 'Atlas & Co.', stage: 'proposal', value: 720000, note: 'Six-seat program proposal in review.', createdAt: day(-8) },
    { id: 'lead-three', name: 'Morgan Lee', email: 'morgan@northstar.example', company: 'Northstar Labs', stage: 'closed', value: 840000, note: 'Fall program confirmed.', createdAt: day(-30) },
  ];
  db.polls = [{ id: 'poll-demo', cohortId: 'cohort-forward', title: 'Choose our next working time', deadline: day(5), status: 'open', slots: Array.from({ length: 7 }, (_, i) => day(7 + i, i % 2 ? 19 : 15)), responses: [{ userId: 'participant-jamie', choices: [0, 2, 4, 1, 3], submittedAt: day(-1) }], winningIndex: null }];
  db.surveys = ['pre', 'mid', 'post'].map((stage, index) => ({ id: `survey-${stage}`, cohortId: 'cohort-forward', title: `${['Starting point', 'Midpoint reflection', 'Closing reflection'][index]}`, stage, deadline: day([7, 28, 70][index]), status: index === 0 ? 'open' : 'draft', questions: ['I feel confident in my leadership practice.', 'I can lead people through change.', 'I collaborate effectively across teams.', 'I have meaningful retention conversations.', 'I have a clear plan for continued growth.'], responses: [] }));
  db.reports = [{ id: 'report-demo', authorId: 'participant-demo', cohortId: 'cohort-forward', participantId: 'participant-demo', type: 'individual', title: 'Alex / Starting-point reflection', highlights: 'A clear focus on having difficult conversations earlier.', progress: 'Baseline recorded. Progress will be revisited at the midpoint.', nextSteps: 'Bring one real conversation to the next session.', shareBuyer: true, status: 'published', createdAt: day(-10), publishedAt: day(-10) }];
  db.reports.push(...sampleCoachEvaluations(today));
  db.documents = [
    { id: 'document-shared', title: 'A conversation worth having', cohortId: 'cohort-forward', scope: 'cohort', participantId: null, sessionId: 'session-2', phase: 'before', originalName: 'conversation-reflection.txt', mime: 'text/plain', inlineContent: 'GOCOACH / A CONVERSATION WORTH HAVING\n\n1. Which conversation have you been avoiding?\n2. What outcome would help both people?\n3. What assumption could you check first?\n4. What is one question you could ask?\n\nBring your reflections to the next session.\n', size: 270, createdAt: day(-3) },
    { id: 'document-private', title: 'Coach preparation / private', cohortId: 'cohort-forward', scope: 'private', participantId: null, sessionId: null, phase: 'resource', originalName: 'coach-preparation.txt', mime: 'text/plain', inlineContent: 'SAMPLE COACH-PRIVATE RESOURCE\n\nOpening: revisit one observed pattern.\nMiddle: work a live case.\nClose: one commitment per person.\n', size: 135, createdAt: day(-3) },
    { id: 'document-buyer', title: 'Sponsor briefing', cohortId: 'cohort-forward', scope: 'buyer', participantId: null, sessionId: null, phase: 'resource', originalName: 'sponsor-briefing.txt', mime: 'text/plain', inlineContent: 'SAMPLE SPONSOR BRIEFING\n\nThe cohort has established its working agreement and baseline goals. Outcomes will be revisited at the midpoint. Individual session notes remain private to the coach.\n', size: 195, createdAt: day(-4) },
  ];
  db.invoices = [{ id: 'invoice-demo', number: 'GC-2026-001', cohortId: 'cohort-forward', buyerId: 'buyer-northstar', title: 'Fall cohort / six seats', amount: 720000, dueDate: day(-7), status: 'issued', payments: [{ id: 'payment-demo', amount: 360000, date: day(-14), method: 'Bank transfer (sample)', reference: 'SAMPLE-001' }], createdAt: day(-21) }];
  db.notifications = [
    { id: 'notice-coach', userId: 'coach-demo', title: 'Your workspace is ready', body: 'Sample data is marked throughout. Begin with a cohort, or explore the client pipeline.', target: 'dashboard', read: false, createdAt: day(0) },
    { id: 'notice-participant', userId: 'participant-demo', title: 'Share your preferred times', body: 'Choose your top five times for the next working session.', target: 'availability', read: false, createdAt: day(0) },
    { id: 'notice-buyer', userId: 'buyer-demo', title: 'A new reflection is available', body: 'Alex’s starting-point reflection has been shared with you.', target: 'reports', read: false, createdAt: day(-1) },
  ];
  return db;
}

/** Illustrative coach assessments for the prototype's sample participants only.
 * @param {Date} now @returns {any[]} */
export function sampleCoachEvaluations(now = new Date()) {
  const reviewedAt = new Date(now.getTime() - 2 * 86400000).toISOString();
  return [
    { id: 'evaluation-alex-demo', participantId: 'participant-demo', title: 'Alex Rivera / Coach evaluation (sample)', highlights: 'Builds trust by listening carefully and asking clear questions. Brings real leadership situations to the coaching work and is receptive to feedback.', progress: 'Early progress toward addressing difficult conversations sooner. The next development area is turning a thoughtful discussion into a clear agreement and following up consistently.', nextSteps: 'Practice one direct feedback conversation before the next session. Agree on a specific action and follow-up date. The manager can support this by making time for a short weekly debrief.' },
    { id: 'evaluation-jamie-demo', participantId: 'participant-jamie', title: 'Jamie Chen / Coach evaluation (sample)', highlights: 'Creates structure around ambiguous work and makes thoughtful contributions to peer discussions. Shows a strong awareness of how decisions affect partner teams.', progress: 'Has identified delegation as the main development priority. The next step is to define an outcome and ownership clearly, then allow the team member to choose the approach.', nextSteps: 'Delegate one recurring responsibility with a written definition of success. Use a planned check-in instead of taking the task back. The manager can reinforce ownership by recognizing the team member’s contribution.' },
  ].map(report => ({ ...report, authorId: 'coach-demo', cohortId: 'cohort-forward', type: 'individual', shareBuyer: true, status: 'published', createdAt: reviewedAt, updatedAt: reviewedAt, publishedAt: reviewedAt }));
}
