import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { ApiError, getDatabase } from './db.ts';
import { MAX_COVER_BYTES } from '../cover-upload.ts';

const db = getDatabase();
db.exec(`CREATE TABLE IF NOT EXISTS recipe_covers (
 household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
 id TEXT NOT NULL, bytes BLOB NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (household_id, id)
)`);

export async function storeCover(householdId: string, bytes: Uint8Array): Promise<string> {
	if (!bytes.length || bytes.length > MAX_COVER_BYTES)
		throw new ApiError(413, 'Cover photo is too large.');
	try {
		const image = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning' });
		const metadata = await image.metadata();
		if (metadata.format !== 'jpeg') throw new Error('Invalid JPEG');
		bytes = await image
			.rotate()
			.resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
			.jpeg({ quality: 80 })
			.toBuffer();
	} catch {
		throw new ApiError(400, 'Could not read this JPEG photo.');
	}
	if (bytes.length > MAX_COVER_BYTES) throw new ApiError(413, 'Cover photo is too large.');
	// Keep recent drafts; reclaim older photos only when no saved recipe references them.
	db.prepare(
		`DELETE FROM recipe_covers WHERE household_id = ? AND created_at < ? AND NOT EXISTS (
	 SELECT 1 FROM household_state, json_each(household_state.state_json, '$.recipes') AS recipe
	 WHERE household_state.household_id = recipe_covers.household_id
	 AND json_extract(recipe.value, '$.image') = '/api/recipe-covers/' || recipe_covers.id
	)`
	).run(householdId, Date.now() - 24 * 60 * 60 * 1000);
	const id = createHash('sha256').update(bytes).digest('hex');
	if (!readCover(householdId, id)) {
		const usage = db
			.prepare(
				'SELECT COALESCE(SUM(length(bytes)), 0) AS total FROM recipe_covers WHERE household_id = ?'
			)
			.get(householdId) as { total: number };
		if (usage.total + bytes.length > 50_000_000)
			throw new ApiError(413, 'This household has reached its cover photo storage limit.');
		db.prepare(
			'INSERT INTO recipe_covers (household_id, id, bytes, created_at) VALUES (?, ?, ?, ?)'
		).run(householdId, id, bytes, Date.now());
	}
	return `/api/recipe-covers/${id}`;
}

export function readCover(householdId: string, id: string): Uint8Array | undefined {
	const row = db
		.prepare('SELECT bytes FROM recipe_covers WHERE household_id = ? AND id = ?')
		.get(householdId, id) as { bytes: Uint8Array } | undefined;
	return row?.bytes;
}
