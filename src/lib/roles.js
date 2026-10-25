// role names and descriptions for the pages (safe to use in the browser)
export const ROLES = ['admin', 'parent', 'child', 'kiosk'];
export const ROLE_TEXT = { admin: 'Admin', parent: 'Parent', child: 'Child', kiosk: 'Kiosk' };
export const ROLE_HELP = {
  admin: 'Can change everything and manage people',
  parent: 'Can change all calendars, groceries and chores',
  child: 'Can add events, private calendars of their own and grocery items, and change only what they added',
  kiosk: 'For the shared tablet: anyone can add groceries; with a person’s PIN it marks their chores done, spends their points and changes their events; a parent’s PIN checks chores'
};

/** Roles that can only change what they added themselves (children, and the shared tablet). */
export const isLimited = (role) => role === 'child' || role === 'kiosk';
export const isAdultRole = (role) => role === 'admin' || role === 'parent';
