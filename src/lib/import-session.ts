import type { RecipeDraftBaseline } from './recipe-draft.ts';
import type { Recipe } from './types.ts';

export type ImportSession = {
	url: string;
	text: string;
	photo: string;
	photoName: string;
	draft: Recipe | null;
	baseline: RecipeDraftBaseline | null;
	assumptions: string[];
};

export const emptyImportSession = (): ImportSession => ({
	url: '',
	text: '',
	photo: '',
	photoName: '',
	draft: null,
	baseline: null,
	assumptions: []
});
