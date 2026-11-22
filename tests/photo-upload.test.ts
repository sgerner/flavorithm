import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
	MAX_AI_PHOTO_BYTES,
	MAX_AI_PHOTO_DATA_URL_LENGTH,
	MAX_AI_PHOTO_EDGE,
	MAX_AI_PHOTO_INPUT_BYTES,
	MAX_COVER_BYTES,
	prepareAIPhoto,
	prepareCover
} from '../src/lib/cover-upload.ts';

type MockOptions = {
	bitmapWidth?: number;
	bitmapHeight?: number;
	decodeError?: Error;
	nullContext?: boolean;
	blobSizeForQuality?: (quality: number) => number | null;
	readerError?: boolean;
};

function installPhotoMocks(t: TestContext, options: MockOptions = {}) {
	const state = {
		decodeCalls: 0,
		bitmapClosed: 0,
		canvasWidth: 0,
		canvasHeight: 0,
		operations: [] as string[],
		qualities: [] as number[]
	};

	class MockFileReader {
		result: string | ArrayBuffer | null = null;
		onload: (() => void) | null = null;
		onerror: (() => void) | null = null;
		onabort: (() => void) | null = null;

		readAsDataURL(blob: Blob) {
			if (options.readerError) {
				queueMicrotask(() => this.onerror?.());
				return;
			}
			void blob.arrayBuffer().then((buffer) => {
				const type = blob.type || 'image/jpeg';
				this.result = `data:${type};base64,${Buffer.from(buffer).toString('base64')}`;
				this.onload?.();
			});
		}
	}

	const overrides: Record<string, unknown> = {
		createImageBitmap: async () => {
			state.decodeCalls += 1;
			if (options.decodeError) throw options.decodeError;
			return {
				width: options.bitmapWidth ?? 4032,
				height: options.bitmapHeight ?? 3024,
				close() {
					state.bitmapClosed += 1;
					state.operations.push('close');
				}
			};
		},
		document: {
			createElement(tag: string) {
				assert.equal(tag, 'canvas');
				const canvas = {
					width: 0,
					height: 0,
					getContext(kind: string) {
						assert.equal(kind, '2d');
						if (options.nullContext) return null;
						return {
							fillStyle: '',
							fillRect(x: number, y: number, w: number, h: number) {
								state.canvasWidth = canvas.width;
								state.canvasHeight = canvas.height;
								state.operations.push(`fill:${this.fillStyle}:${x},${y},${w},${h}`);
							},
							drawImage(_img: unknown, x: number, y: number, w: number, h: number) {
								state.operations.push(`draw:${x},${y},${w},${h}`);
							}
						};
					},
					toBlob(callback: (blob: Blob | null) => void, type: string, quality: number) {
						assert.equal(type, 'image/jpeg');
						state.qualities.push(quality);
						const size = options.blobSizeForQuality ? options.blobSizeForQuality(quality) : 128;
						queueMicrotask(() => {
							callback(size === null ? null : new Blob([new Uint8Array(size)], { type }));
						});
					}
				};
				return canvas;
			}
		},
		FileReader: MockFileReader
	};

	for (const [name, value] of Object.entries(overrides)) {
		const previous = Object.getOwnPropertyDescriptor(globalThis, name);
		Object.defineProperty(globalThis, name, { configurable: true, value });
		t.after(() => {
			if (previous) Object.defineProperty(globalThis, name, previous);
			else Reflect.deleteProperty(globalThis, name);
		});
	}

	return state;
}

function fakeFile(size: number, type = 'image/jpeg', name = 'camera.jpg'): File {
	const file = new File(['x'], name, { type });
	Object.defineProperty(file, 'size', { value: size });
	return file;
}

test('prepareAIPhoto scales longest edge to 1600px, fills white background, avoids upscaling, and accepts up to 20 MB', async (t) => {
	const landscape = installPhotoMocks(t, { bitmapWidth: 4032, bitmapHeight: 3024 });
	const dataUrl = await prepareAIPhoto(
		fakeFile(MAX_AI_PHOTO_INPUT_BYTES, 'image/png', 'recipe.png')
	);
	assert.match(dataUrl, /^data:image\/jpeg;base64,/);
	assert.ok(dataUrl.length < MAX_AI_PHOTO_DATA_URL_LENGTH);
	assert.equal(landscape.canvasWidth, MAX_AI_PHOTO_EDGE);
	assert.equal(landscape.canvasHeight, 1200);
	assert.deepEqual(landscape.operations, [
		'fill:#fff:0,0,1600,1200',
		'draw:0,0,1600,1200',
		'close'
	]);
	assert.equal(landscape.bitmapClosed, 1);

	const portrait = installPhotoMocks(t, { bitmapWidth: 3024, bitmapHeight: 4032 });
	await prepareAIPhoto(fakeFile(8_500_000, 'image/webp', 'pantry.webp'));
	assert.equal(portrait.canvasWidth, 1200);
	assert.equal(portrait.canvasHeight, MAX_AI_PHOTO_EDGE);
	assert.equal(portrait.bitmapClosed, 1);

	const small = installPhotoMocks(t, { bitmapWidth: 900, bitmapHeight: 600 });
	await prepareAIPhoto(fakeFile(250_000, 'image/jpeg', 'small.jpg'));
	assert.equal(small.canvasWidth, 900);
	assert.equal(small.canvasHeight, 600);
	assert.equal(small.bitmapClosed, 1);
});

test('prepareAIPhoto enforces 20 MB input limit and rejects unsupported file formats before decoding', async (t) => {
	const state = installPhotoMocks(t);

	await assert.rejects(
		prepareAIPhoto(fakeFile(MAX_AI_PHOTO_INPUT_BYTES + 1, 'image/jpeg')),
		/Choose a photo under 20 MB\./
	);
	await assert.rejects(
		prepareAIPhoto(fakeFile(1_024, 'image/heic', 'IMG_0001.HEIC')),
		/Choose a JPG, PNG, or WebP photo\./
	);
	await assert.rejects(
		prepareAIPhoto(fakeFile(1_024, 'application/pdf', 'recipe.pdf'), {
			unsupportedMessage:
				'Choose a JPG, PNG, or WebP photo. For other files, paste their recipe text.'
		}),
		/paste their recipe text/
	);
	assert.equal(state.decodeCalls, 0);
});

test('prepareAIPhoto falls back to lower JPEG qualities to stay below 1.5 MB and 2 MB data URL limits', async (t) => {
	const fallback = installPhotoMocks(t, {
		blobSizeForQuality: (quality) => {
			if (quality === 0.85) return MAX_AI_PHOTO_BYTES; // 1.5 MB exact -> rejected (must be below 1.5 MB)
			if (quality === 0.7) return 1_499_995; // < 1.5 MB, but base64 data URL exceeds 2_000_000 chars
			if (quality === 0.5) return 420_000;
			return 200_000;
		}
	});
	const result = await prepareAIPhoto(fakeFile(12_000_000, 'image/jpeg'));
	assert.deepEqual(fallback.qualities, [0.85, 0.7, 0.5]);
	assert.ok(result.length < MAX_AI_PHOTO_DATA_URL_LENGTH);
	assert.equal(fallback.bitmapClosed, 1);

	const tooDetailed = installPhotoMocks(t, {
		blobSizeForQuality: () => MAX_AI_PHOTO_BYTES + 50_000
	});
	await assert.rejects(
		prepareAIPhoto(fakeFile(12_000_000, 'image/jpeg')),
		/This photo is too detailed\. Try a smaller photo\./
	);
	assert.deepEqual(tooDetailed.qualities, [0.85, 0.7, 0.5, 0.3]);
	assert.equal(tooDetailed.bitmapClosed, 1);
});

test('prepareAIPhoto catches decode, canvas, and FileReader errors and releases ImageBitmap', async (t) => {
	installPhotoMocks(t, { decodeError: new Error('EncodingError: cannot decode') });
	await assert.rejects(
		prepareAIPhoto(fakeFile(500_000, 'image/jpeg')),
		/Could not read that photo\. Try another file\./
	);

	const noContext = installPhotoMocks(t, { nullContext: true });
	await assert.rejects(
		prepareAIPhoto(fakeFile(500_000, 'image/jpeg')),
		/Could not prepare this photo\./
	);
	assert.equal(noContext.bitmapClosed, 1);

	const readerFailed = installPhotoMocks(t, { readerError: true });
	await assert.rejects(
		prepareAIPhoto(fakeFile(500_000, 'image/jpeg')),
		/Could not read that photo\. Try another file\./
	);
	assert.equal(readerFailed.bitmapClosed, 1);
});

test('prepareCover keeps existing 10 MB input limit, 1200px edge, and 300 KB output cap', async (t) => {
	const state = installPhotoMocks(t, {
		bitmapWidth: 2400,
		bitmapHeight: 1200,
		blobSizeForQuality: (quality) => (quality > 0.7 ? MAX_COVER_BYTES + 10 : MAX_COVER_BYTES)
	});
	await assert.rejects(
		prepareCover(fakeFile(10_000_001, 'image/jpeg')),
		/Choose a photo under 10 MB\./
	);
	assert.equal(state.decodeCalls, 0);

	const blob = await prepareCover(fakeFile(9_000_000, 'image/jpeg'));
	assert.equal(blob.size, MAX_COVER_BYTES);
	assert.equal(state.canvasWidth, 1200);
	assert.equal(state.canvasHeight, 600);
	assert.deepEqual(state.qualities, [0.85, 0.7]);
	assert.equal(state.bitmapClosed, 1);
});
