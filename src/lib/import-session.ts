import type { Recipe } from './types.ts';

export type ImportSession = {
	text: string;
	photo: string;
	photoName: string;
	draft: Recipe | null;
	assumptions: string[];
};

export const emptyImportSession = (): ImportSession => ({
	text: '',
	photo: '',
	photoName: '',
	draft: null,
	assumptions: []
});
