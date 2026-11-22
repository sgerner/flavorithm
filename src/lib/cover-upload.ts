export const MAX_COVER_BYTES = 300_000;
export const COVER_PATH = /^\/api\/recipe-covers\/[a-f0-9]{64}$/;
export const MAX_AI_PHOTO_INPUT_BYTES = 20_000_000;
export const MAX_AI_PHOTO_EDGE = 1600;
export const MAX_AI_PHOTO_BYTES = 1_500_000;
export const MAX_AI_PHOTO_DATA_URL_LENGTH = 2_000_000;

const SUPPORTED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const JPEG_QUALITIES = [0.85, 0.7, 0.5, 0.3];

async function drawPhotoCanvas(
	file: File,
	maxInputBytes: number,
	maxInputLabel: string,
	maxEdge: number,
	unsupportedMessage = 'Choose a JPG, PNG, or WebP photo.'
): Promise<HTMLCanvasElement> {
	if (!SUPPORTED_PHOTO_TYPES.includes(file.type.toLowerCase())) {
		throw new Error(unsupportedMessage);
	}
	if (file.size > maxInputBytes) {
		throw new Error(`Choose a photo under ${maxInputLabel}.`);
	}
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file);
	} catch {
		throw new Error('Could not read that photo. Try another file.');
	}
	try {
		if (bitmap.width <= 0 || bitmap.height <= 0) {
			throw new Error('Could not read that photo. Try another file.');
		}
		const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
		const canvas = document.createElement('canvas');
		canvas.width = Math.max(1, Math.round(bitmap.width * scale));
		canvas.height = Math.max(1, Math.round(bitmap.height * scale));
		const context = canvas.getContext('2d');
		if (!context) throw new Error('Could not prepare this photo.');
		context.fillStyle = '#fff';
		context.fillRect(0, 0, canvas.width, canvas.height);
		context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		return canvas;
	} finally {
		bitmap.close();
	}
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
	return new Promise((resolve, reject) => {
		try {
			canvas.toBlob(resolve, 'image/jpeg', quality);
		} catch {
			reject(new Error('Could not prepare this photo.'));
		}
	});
}

function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const fail = () => reject(new Error('Could not read that photo. Try another file.'));
		let reader: FileReader;
		try {
			reader = new FileReader();
		} catch {
			fail();
			return;
		}
		reader.onload = () => {
			if (typeof reader.result === 'string' && reader.result.startsWith('data:image/')) {
				resolve(reader.result);
			} else {
				fail();
			}
		};
		reader.onerror = fail;
		reader.onabort = fail;
		try {
			reader.readAsDataURL(blob.type ? blob : new Blob([blob], { type: 'image/jpeg' }));
		} catch {
			fail();
		}
	});
}

/** Decode and redraw to bound storage, correct orientation, and discard camera metadata. */
export async function prepareCover(file: File): Promise<Blob> {
	const canvas = await drawPhotoCanvas(file, 10_000_000, '10 MB', 1200);
	for (const quality of JPEG_QUALITIES) {
		const blob = await canvasToJpeg(canvas, quality);
		if (blob && blob.size <= MAX_COVER_BYTES) return blob;
	}
	throw new Error('This photo is too detailed. Try a smaller photo.');
}

/** Resize and compress a photo for AI vision or recipe capture into a bounded JPEG data URL. */
export async function prepareAIPhoto(
	file: File,
	options?: { unsupportedMessage?: string }
): Promise<string> {
	const canvas = await drawPhotoCanvas(
		file,
		MAX_AI_PHOTO_INPUT_BYTES,
		'20 MB',
		MAX_AI_PHOTO_EDGE,
		options?.unsupportedMessage
	);
	for (const quality of JPEG_QUALITIES) {
		const blob = await canvasToJpeg(canvas, quality);
		if (blob && blob.size < MAX_AI_PHOTO_BYTES) {
			const dataUrl = await blobToDataUrl(blob);
			if (dataUrl.length < MAX_AI_PHOTO_DATA_URL_LENGTH) return dataUrl;
		}
	}
	throw new Error('This photo is too detailed. Try a smaller photo.');
}
