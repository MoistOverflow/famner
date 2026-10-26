// Shared test helpers: a fresh database in a temporary folder for each test file (never data/).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function freshDbPath() {
	const dir = mkdtempSync(join(tmpdir(), 'famner-test-'));
	process.env.BACKUP_DIR = join(dir, 'backups');
	return join(dir, 'calendar.db');
}

/** A household: an admin (Dad), a parent (Mom), a child (Sam) and a kiosk, all past first sign-in. */
export async function household(A, db) {
	const dad = await A.createFirstAdmin(db, {
		username: 'dad',
		name: 'Dad',
		password: 'family-admin-1'
	});
	const make = async (username, name, role) => {
		const { user } = await A.createUser(db, dad, { username, name, role });
		db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(user.id);
		return user;
	};
	return {
		dad,
		mom: await make('mom', 'Mom', 'parent'),
		sam: await make('sam', 'Sam', 'child'),
		tab: await make('tablet', 'Tablet', 'kiosk')
	};
}
