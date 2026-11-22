import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { focusTrap } from '../src/lib/focus.ts';

type KeyListener = (event: KeyboardEvent) => void;

class MockElement {
	tagName: string;
	id: string;
	disabled = false;
	href = '';
	tabIndex = -1;
	inert = false;
	hidden = false;
	style = { overflow: '' };
	parentElement: MockElement | null = null;
	children: MockElement[] = [];
	ownerDocument: MockDocument;
	private listeners = new Map<string, Set<KeyListener>>();

	constructor(doc: MockDocument, tagName: string, id = '') {
		this.ownerDocument = doc;
		this.tagName = tagName.toLowerCase();
		this.id = id;
		if (['button', 'input', 'select', 'textarea'].includes(this.tagName)) {
			this.tabIndex = 0;
		}
	}

	get isConnected(): boolean {
		let current: MockElement | null = this;
		while (current) {
			if (current === this.ownerDocument.body) return true;
			current = current.parentElement;
		}
		return false;
	}

	get offsetParent(): MockElement | null {
		if (!this.isConnected || this.hidden) return null;
		let current: MockElement | null = this.parentElement;
		while (current) {
			if (current.hidden) return null;
			current = current.parentElement;
		}
		return this.ownerDocument.body;
	}

	append(...nodes: MockElement[]) {
		for (const child of nodes) {
			child.remove();
			child.parentElement = this;
			this.children.push(child);
		}
		return this;
	}

	remove() {
		if (!this.parentElement) return;
		this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
		this.parentElement = null;
		if (this.ownerDocument.activeElement && !this.ownerDocument.activeElement.isConnected) {
			this.ownerDocument.activeElement = this.ownerDocument.body;
		}
	}

	contains(target: unknown): boolean {
		let current = target as MockElement | null;
		while (current) {
			if (current === this) return true;
			current = current.parentElement;
		}
		return false;
	}

	closest(selector: string): MockElement | null {
		if (selector !== '[inert]') return null;
		let current: MockElement | null = this;
		while (current) {
			if (current.inert) return current;
			current = current.parentElement;
		}
		return null;
	}

	private matchesFocusable(selector: string): boolean {
		if (this.tagName === 'button' && !this.disabled) return true;
		if (this.tagName === 'a' && Boolean(this.href)) return true;
		if (this.tagName === 'input' && !this.disabled) return true;
		if (this.tagName === 'select' && !this.disabled) return true;
		if (this.tagName === 'textarea' && !this.disabled) return true;
		if (selector.includes('[tabindex]:not([tabindex="-1"])')) {
			if (this.tabIndex !== -1 && !this.disabled) return true;
		} else if (this.tabIndex === 0 && !this.disabled) {
			return true;
		}
		return false;
	}

	querySelectorAll(selector = ''): MockElement[] {
		const found: MockElement[] = [];
		const visit = (parent: MockElement) => {
			for (const child of parent.children) {
				if (child.matchesFocusable(selector)) found.push(child);
				visit(child);
			}
		};
		visit(this);
		return found;
	}

	focus() {
		if (!this.isConnected || this.closest('[inert]')) return;
		this.ownerDocument.activeElement = this;
		this.ownerDocument.focusHistory.push(this.id || this.tagName);
	}

	addEventListener(type: string, listener: KeyListener) {
		let set = this.listeners.get(type);
		if (!set) {
			set = new Set();
			this.listeners.set(type, set);
		}
		set.add(listener);
	}

	removeEventListener(type: string, listener: KeyListener) {
		this.listeners.get(type)?.delete(listener);
	}

	dispatchTab(shiftKey = false) {
		let defaultPrevented = false;
		const event = {
			key: 'Tab',
			shiftKey,
			get defaultPrevented() {
				return defaultPrevented;
			},
			preventDefault() {
				defaultPrevented = true;
			}
		} as KeyboardEvent;
		for (const listener of this.listeners.get('keydown') ?? []) {
			listener(event);
		}
		return defaultPrevented;
	}
}

class MockDocument {
	body: MockElement;
	activeElement: MockElement | null;
	focusHistory: string[] = [];

	constructor() {
		this.body = new MockElement(this, 'body', 'body');
		this.activeElement = this.body;
	}

	el(tagName: string, id: string, props: Partial<MockElement> = {}) {
		const element = new MockElement(this, tagName, id);
		Object.assign(element, props);
		return element;
	}
}

function installDom(t: TestContext) {
	const doc = new MockDocument();
	const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
	Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
	t.after(() => {
		if (previous) Object.defineProperty(globalThis, 'document', previous);
		else Reflect.deleteProperty(globalThis, 'document');
	});
	return doc;
}

const flushMicrotasks = () => new Promise<void>((resolve) => queueMicrotask(resolve));

test('nested traps restrict Tab to the top trap and restore focus through each layer', async (t) => {
	const doc = installDom(t);
	doc.body.style.overflow = 'clip';

	const cardTrigger = doc.el('button', 'recipe-card');
	const detailWrapper = doc.el('div', 'detail-wrapper');
	const detailDialog = doc.el('div', 'detail-dialog', { tabIndex: -1 });
	const closeDetail = doc.el('button', 'close-detail');
	const editButton = doc.el('button', 'edit-recipe');
	detailDialog.append(closeDetail, editButton);
	detailWrapper.append(detailDialog);

	const editorDialog = doc.el('div', 'editor-dialog', { tabIndex: -1 });
	const titleInput = doc.el('input', 'editor-title');
	const saveButton = doc.el('button', 'editor-save');
	editorDialog.append(titleInput, saveButton);

	doc.body.append(cardTrigger);
	cardTrigger.focus();

	doc.body.append(detailWrapper);
	const detailTrap = focusTrap(detailDialog as unknown as HTMLElement);
	assert.equal(doc.body.style.overflow, 'hidden');
	await flushMicrotasks();
	assert.equal(doc.activeElement, closeDetail);

	// Move focus to Edit button inside RecipeDetail and open nested RecipeEditor trap.
	editButton.focus();
	detailWrapper.inert = true;
	doc.body.append(editorDialog);
	const editorTrap = focusTrap(editorDialog as unknown as HTMLElement);
	await flushMicrotasks();
	assert.equal(doc.activeElement, titleInput);

	// Tab wraps only inside topmost editor trap; parent trap ignores Tab while covered.
	assert.equal(editorDialog.dispatchTab(true), true);
	assert.equal(doc.activeElement, saveButton);
	assert.equal(editorDialog.dispatchTab(false), true);
	assert.equal(doc.activeElement, titleInput);
	assert.equal(detailDialog.dispatchTab(false), false);
	assert.equal(doc.activeElement, titleInput);

	// Closing child trap restores focus to Edit button in RecipeDetail and keeps overflow locked.
	detailWrapper.inert = false;
	editorDialog.remove();
	editorTrap.destroy();
	assert.equal(doc.body.style.overflow, 'hidden');
	await flushMicrotasks();
	assert.equal(doc.activeElement, editButton);

	// Tab trapping works in RecipeDetail again once it is back on top.
	assert.equal(detailDialog.dispatchTab(false), true);
	assert.equal(doc.activeElement, closeDetail);

	// Closing parent trap restores focus to cardTrigger and restores original body overflow.
	detailWrapper.remove();
	detailTrap.destroy();
	assert.equal(doc.body.style.overflow, 'clip');
	await flushMicrotasks();
	assert.equal(doc.activeElement, cardTrigger);
});

test('falls back to the first control in the active top trap when returnFocus is disconnected or inert', async (t) => {
	const doc = installDom(t);

	const pageButton = doc.el('button', 'page-open');
	const parentDialog = doc.el('div', 'parent-dialog', { tabIndex: -1 });
	const parentFirst = doc.el('button', 'parent-first');
	const removableTrigger = doc.el('button', 'removable-trigger');
	const inertSection = doc.el('div', 'inert-section');
	const inertTrigger = doc.el('button', 'inert-trigger');
	inertSection.append(inertTrigger);
	parentDialog.append(parentFirst, removableTrigger, inertSection);

	doc.body.append(pageButton, parentDialog);
	pageButton.focus();
	const parentTrap = focusTrap(parentDialog as unknown as HTMLElement);
	await flushMicrotasks();
	assert.equal(doc.activeElement, parentFirst);

	// Case 1: !returnFocus.isConnected falls back to first control in active top trap.
	removableTrigger.focus();
	const childA = doc.el('div', 'child-a', { tabIndex: -1 });
	const childAButton = doc.el('button', 'child-a-btn');
	childA.append(childAButton);
	doc.body.append(childA);
	const childATrap = focusTrap(childA as unknown as HTMLElement);
	await flushMicrotasks();
	assert.equal(doc.activeElement, childAButton);

	removableTrigger.remove();
	childA.remove();
	childATrap.destroy();
	await flushMicrotasks();
	assert.equal(doc.activeElement, parentFirst);

	// Case 2: returnFocus.closest('[inert]') falls back to first non-inert control in active top trap.
	inertTrigger.focus();
	const childB = doc.el('div', 'child-b', { tabIndex: -1 });
	const childBButton = doc.el('button', 'child-b-btn');
	childB.append(childBButton);
	doc.body.append(childB);
	const childBTrap = focusTrap(childB as unknown as HTMLElement);
	await flushMicrotasks();
	assert.equal(doc.activeElement, childBButton);

	inertSection.inert = true;
	childB.remove();
	childBTrap.destroy();
	await flushMicrotasks();
	assert.equal(doc.activeElement, parentFirst);

	parentDialog.remove();
	parentTrap.destroy();
	await flushMicrotasks();
	assert.equal(doc.activeElement, pageButton);
});

test('reduced-motion synchronous {#key modal} handoff skips intermediate focus restore and preserves returnFocus', async (t) => {
	const doc = installDom(t);
	doc.body.style.overflow = 'auto';

	const detailWrapper = doc.el('div', 'detail-wrapper');
	const detailDialog = doc.el('div', 'detail-dialog', { tabIndex: -1 });
	const closeDetail = doc.el('button', 'close-detail');
	const refreshNutrition = doc.el('button', 'refresh-nutrition');
	detailDialog.append(closeDetail, refreshNutrition);
	detailWrapper.append(detailDialog);
	doc.body.append(detailWrapper);

	const detailTrap = focusTrap(detailDialog as unknown as HTMLElement);
	await flushMicrotasks();
	refreshNutrition.focus();

	// Open settings modal over inert RecipeDetail.
	detailWrapper.inert = true;
	const settingsDialog = doc.el('div', 'settings-dialog', { tabIndex: -1 });
	const editTaste = doc.el('button', 'edit-taste');
	settingsDialog.append(editTaste);
	doc.body.append(settingsDialog);
	const settingsTrap = focusTrap(settingsDialog as unknown as HTMLElement);
	await flushMicrotasks();
	assert.equal(doc.activeElement, editTaste);

	doc.focusHistory = [];

	// Reduced-motion {#key modal} replacement: settings destroys synchronously, onboarding mounts in same tick.
	settingsDialog.remove();
	settingsTrap.destroy();
	const onboardingDialog = doc.el('div', 'onboarding-dialog', { tabIndex: -1 });
	const savePrefs = doc.el('button', 'save-prefs');
	onboardingDialog.append(savePrefs);
	doc.body.append(onboardingDialog);
	const onboardingTrap = focusTrap(onboardingDialog as unknown as HTMLElement);

	assert.equal(doc.body.style.overflow, 'hidden');
	await flushMicrotasks();
	assert.deepEqual(doc.focusHistory, ['save-prefs']);
	assert.equal(doc.activeElement, savePrefs);

	// Closing onboarding restores focus to refreshNutrition in RecipeDetail.
	detailWrapper.inert = false;
	onboardingDialog.remove();
	onboardingTrap.destroy();
	await flushMicrotasks();
	assert.equal(doc.activeElement, refreshNutrition);

	detailWrapper.remove();
	detailTrap.destroy();
	assert.equal(doc.body.style.overflow, 'auto');
});

test('animated {#key modal} replacement skips focus restore when outgoing trap finishes later', async (t) => {
	const doc = installDom(t);
	doc.body.style.overflow = 'scroll';

	const plannerTrigger = doc.el('button', 'planner-add');
	doc.body.append(plannerTrigger);
	plannerTrigger.focus();

	// Open pickRecipe modal.
	const pickDialog = doc.el('div', 'pick-dialog', { tabIndex: -1 });
	const pickItem = doc.el('button', 'pick-pasta');
	pickDialog.append(pickItem);
	doc.body.append(pickDialog);
	const pickTrap = focusTrap(pickDialog as unknown as HTMLElement);
	await flushMicrotasks();
	assert.equal(doc.activeElement, pickItem);

	// Click recipe -> {#key modal} mounts planDialog while pickDialog is still playing outro transition.
	const planDialog = doc.el('div', 'plan-dialog', { tabIndex: -1 });
	const dateInput = doc.el('input', 'plan-date');
	const servingsInput = doc.el('input', 'plan-servings');
	planDialog.append(dateInput, servingsInput);
	doc.body.append(planDialog);
	const planTrap = focusTrap(planDialog as unknown as HTMLElement);
	await flushMicrotasks();
	assert.equal(doc.activeElement, dateInput);

	// User moves focus to servingsInput before pickDialog finishes its outro transition.
	servingsInput.focus();
	doc.focusHistory = [];

	// Outgoing pickDialog finishes outro and destroys: must NOT steal focus from servingsInput.
	pickDialog.remove();
	pickTrap.destroy();
	await flushMicrotasks();
	assert.equal(doc.activeElement, servingsInput);
	assert.deepEqual(doc.focusHistory, []);
	assert.equal(doc.body.style.overflow, 'hidden');

	// Closing planDialog restores focus to the original plannerTrigger and restores overflow.
	planDialog.remove();
	planTrap.destroy();
	assert.equal(doc.body.style.overflow, 'scroll');
	await flushMicrotasks();
	assert.equal(doc.activeElement, plannerTrigger);
});

test('includes focusable scroll regions with non-negative tabindex while skipping tabindex="-1"', async (t) => {
	const doc = installDom(t);

	const dialog = doc.el('div', 'chat-dialog', { tabIndex: -1 });
	const closeBtn = doc.el('button', 'close-chat');
	const skippedNote = doc.el('div', 'programmatic-only', { tabIndex: -1 });
	const scrollRegion = doc.el('div', 'transcript-region', { tabIndex: 0 });
	const customOrder = doc.el('div', 'custom-tabindex', { tabIndex: 1 });
	dialog.append(closeBtn, skippedNote, scrollRegion, customOrder);
	doc.body.append(dialog);

	const trap = focusTrap(dialog as unknown as HTMLElement);
	await flushMicrotasks();
	assert.equal(doc.activeElement, closeBtn);

	customOrder.focus();
	assert.equal(dialog.dispatchTab(false), true);
	assert.equal(doc.activeElement, closeBtn);

	assert.equal(dialog.dispatchTab(true), true);
	assert.equal(doc.activeElement, customOrder);

	dialog.remove();
	trap.destroy();
});
