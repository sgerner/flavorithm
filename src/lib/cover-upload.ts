export const MAX_COVER_BYTES = 300_000;
export const COVER_PATH = /^\/api\/recipe-covers\/[a-f0-9]{64}$/;

/** Decode and redraw to bound storage, correct orientation, and discard camera metadata. */
export async function prepareCover(file: File): Promise<Blob> {
	if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type))
		throw new Error('Choose a JPG, PNG, or WebP photo.');
	if (file.size > 10_000_000) throw new Error('Choose a photo under 10 MB.');
	const bitmap = await createImageBitmap(file);
	try {
		const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
		const canvas = document.createElement('canvas');
		canvas.width = Math.max(1, Math.round(bitmap.width * scale));
		canvas.height = Math.max(1, Math.round(bitmap.height * scale));
		const context = canvas.getContext('2d');
		if (!context) throw new Error('Could not prepare this photo.');
		context.fillStyle = '#fff';
		context.fillRect(0, 0, canvas.width, canvas.height);
		context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		for (const quality of [0.85, 0.7, 0.5, 0.3]) {
			const blob = await new Promise<Blob | null>((resolve) =>
				canvas.toBlob(resolve, 'image/jpeg', quality)
			);
			if (blob && blob.size <= MAX_COVER_BYTES) return blob;
		}
		throw new Error('This photo is too detailed. Try a smaller photo.');
	} finally {
		bitmap.close();
	}
}
