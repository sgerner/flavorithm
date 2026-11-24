import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { activeFocusedElement, focusableControls, focusTrap } from '../src/lib/focus.ts';

type EventListenerFn = (event: any) => void;

class MockElement {
	tagName: string;
	id: string;
	disabled = false;
	href = '';
	tabIndex = -1;
	hasExplicitTabIndex = false;
	inert = false;
	hidden = false;
	open = false;
	scrollTop = 0;
	style = { overflow: '', display: '', visibility: '', position: '' };
	parentElement: MockElement | null = null;
	children: MockElement[] = [];
	ownerDocument: MockDocument;
	lastFocusOptions: FocusOptions | undefined;
	private attributes = new Map<string, string>();
	private listeners = new Map<string, Set<EventListenerFn>>();

	constructor(doc: MockDocument, tagName: string, id = '') {
		this.ownerDocument = doc;
		this.tagName = tagName.toLowerCase();
		this.id = id;
		if (['button', 'input', 'select', 'textarea', 'summary'].includes(this.tagName)) {
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
		if (!this.isConnected || this.hidden || this.style.display === 'none') return null;
		if (this.style.position === 'fixed') return null;
		let current: MockElement | null = this.parentElement;
		while (current) {
			if (current.hidden || current.style.display === 'none') return null;
			current = current.parentElement;
		}
		return this.ownerDocument.body;
	}

	setAttribute(name: string, value: string) {
		this.attributes.set(name, value);
	}

	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}

	removeAttribute(name: string) {
		this.attributes.delete(name);
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
		const checkInert = selector.includes('[inert]');
		const checkHidden = selector.includes('[hidden]');
		if (!checkInert && !checkHidden) return null;
		let current: MockElement | null = this;
		while (current) {
			if ((checkInert && current.inert) || (checkHidden && current.hidden)) return current;
			current = current.parentElement;
		}
		return null;
	}

	private isFirstSummaryOfDetails(): boolean {
		if (this.tagName !== 'summary' || this.parentElement?.tagName !== 'details') return false;
		const firstSummary = this.parentElement.children.find((child) => child.tagName === 'summary');
		return firstSummary === this;
	}

	private matchesFocusable(selector: string): boolean {
		if (this.tabIndex === -1 && selector.includes(':not([tabindex="-1"])')) return false;
		if (this.tagName === 'button' && !this.disabled) return true;
		if (this.tagName === 'a' && Boolean(this.href)) return true;
		if (this.tagName === 'input' && !this.disabled) return true;
		if (this.tagName === 'select' && !this.disabled) return true;
		if (this.tagName === 'textarea' && !this.disabled) return true;
		if (selector.includes('details > summary:first-of-type') && this.isFirstSummaryOfDetails()) {
			return true;
		}
		if (selector.includes('[tabindex]:not([tabindex="-1"])')) {
			if (this.hasExplicitTabIndex && this.tabIndex !== -1 && !this.disabled) return true;
		} else if (this.hasExplicitTabIndex && this.tabIndex === 0 && !this.disabled) {
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

	focus(options?: FocusOptions) {
		if (!this.isConnected || this.closest('[hidden], [inert]')) return;
		this.lastFocusOptions = options;
		this.ownerDocument.activeElement = this;
		this.ownerDocument.focusHistory.push(this.id || this.tagName);
	}

	addEventListener(type: string, listener: EventListenerFn) {
		let set = this.listeners.get(type);
		if (!set) {
			set = new Set();
			this.listeners.set(type, set);
		}
		set.add(listener);
	}

	removeEventListener(type: string, listener: EventListenerFn) {
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

	dispatchOutroStart(target: MockElement = this) {
		const event = { type: 'outrostart', target } as unknown as Event;
		for (const listener of [...(this.listeners.get('outrostart') ?? [])]) {
			listener(event);
		}
	}
}

class MockDocument {
	body: MockElement;
	documentElement: MockElement;
	activeElement: MockElement | null;
	focusHistory: string[] = [];

	constructor() {
		this.documentElement = new MockElement(this, 'html', 'html');
		this.body = new MockElement(this, 'body', 'body');
		this.documentElement.children.push(this.body);
		this.activeElement = this.body;
	}

	el(tagName: string, id: string, props: Partial<MockElement> = {}) {
		const element = new MockElement(this, tagName, id);
		if ('tabIndex' in props) element.hasExplicitTabIndex = true;
		Object.assign(element, props);
		return element;
	}
}

function installDom(t: TestContext) {
	const doc = new MockDocument();
	const mockWindow = {
		getComputedStyle(el: MockElement) {
			return {
				display: el.style.display || 'block',
				visibility: el.style.visibility || 'visible',
				position: el.style.position || 'static'
			};
		}
	};
	const previousDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
	const previousWin = Object.getOwnPropertyDescriptor(globalThis, 'window');
	Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
	Object.defineProperty(globalThis, 'window', { configurable: true, value: mockWindow });
	t.after(() => {
		if (previousDoc) Object.defineProperty(globalThis, 'document', previousDoc);
		else Reflect.deleteProperty(globalThis, 'document');
		if (previousWin) Object.defineProperty(globalThis, 'window', previousWin);
		else Reflect.deleteProperty(globalThis, 'window');
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

	// Closing child trap restores focus to Edit button in RecipeDetail with preventScroll and keeps overflow locked.
	detailWrapper.inert = false;
	editorDialog.remove();
	editorTrap.destroy();
	assert.equal(doc.body.style.overflow, 'hidden');
	await flushMicrotasks();
	assert.equal(doc.activeElement, editButton);
	assert.deepEqual(editButton.lastFocusOptions, { preventScroll: true });

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

test('pre-captured returnFocus restores focus even when ancestor inert blurs activeElement to body before mount', async (t) => {
	const doc = installDom(t);

	const detailWrapper = doc.el('div', 'detail-wrapper');
	const detailDialog = doc.el('div', 'detail-dialog', { tabIndex: -1 });
	const closeDetail = doc.el('button', 'close-detail');
	const editButton = doc.el('button', 'edit-recipe');
	detailDialog.append(closeDetail, editButton);
	detailWrapper.append(detailDialog);
	doc.body.append(detailWrapper);

	const detailTrap = focusTrap(detailDialog as unknown as HTMLElement);
	await flushMicrotasks();
	editButton.focus();

	// Capture return target before state update, then simulate browser blurring activeElement to body when inert=true.
	const capturedTrigger = activeFocusedElement();
	assert.equal(capturedTrigger, editButton);
	detailWrapper.inert = true;
	doc.activeElement = doc.body;
	assert.equal(activeFocusedElement(), null);

	const editorDialog = doc.el('div', 'editor-dialog', { tabIndex: -1 });
	const cancelBtn = doc.el('button', 'cancel-edit');
	editorDialog.append(cancelBtn);
	doc.body.append(editorDialog);

	const editorTrap = focusTrap(editorDialog as unknown as HTMLElement, {
		returnFocus: capturedTrigger
	});
	await flushMicrotasks();
	assert.equal(doc.activeElement, cancelBtn);

	// Closing RecipeEditor restores focus to Edit button rather than document.body.
	detailWrapper.inert = false;
	editorDialog.remove();
	editorTrap.destroy();
	await flushMicrotasks();
	assert.equal(doc.activeElement, editButton);

	detailWrapper.remove();
	detailTrap.destroy();
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
	const modalReturnFocus = activeFocusedElement();
	detailWrapper.inert = true;
	doc.activeElement = doc.body;
	const settingsDialog = doc.el('div', 'settings-dialog', { tabIndex: -1 });
	const editTaste = doc.el('button', 'edit-taste');
	settingsDialog.append(editTaste);
	doc.body.append(settingsDialog);
	const settingsTrap = focusTrap(settingsDialog as unknown as HTMLElement, {
		returnFocus: modalReturnFocus
	});
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
	const onboardingTrap = focusTrap(onboardingDialog as unknown as HTMLElement, {
		returnFocus: modalReturnFocus
	});

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

test('animated {#key modal} replacement and outrostart deactivate outgoing trap cleanly without stealing focus', async (t) => {
	const doc = installDom(t);
	doc.body.style.overflow = 'scroll';

	const plannerTrigger = doc.el('button', 'planner-add');
	doc.body.append(plannerTrigger);
	plannerTrigger.focus();

	// Open pickRecipe modal.
	const pickDialog = doc.el('div', 'pick-dialog', { tabIndex: -1 });
	pickDialog.setAttribute('aria-modal', 'true');
	const pickItem = doc.el('button', 'pick-pasta');
	pickDialog.append(pickItem);
	doc.body.append(pickDialog);
	const pickTrap = focusTrap(pickDialog as unknown as HTMLElement);
	await flushMicrotasks();
	assert.equal(doc.activeElement, pickItem);

	// Click recipe -> {#key modal} mounts planDialog while pickDialog begins its outro transition.
	const planDialog = doc.el('div', 'plan-dialog', { tabIndex: -1 });
	const dateInput = doc.el('input', 'plan-date');
	const servingsInput = doc.el('input', 'plan-servings');
	planDialog.append(dateInput, servingsInput);
	doc.body.append(planDialog);
	const planTrap = focusTrap(planDialog as unknown as HTMLElement);
	pickDialog.dispatchOutroStart();
	assert.equal(pickDialog.getAttribute('aria-modal'), null);
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

test('supports { enabled, key } updates, closed details/summary, fixed controls, and non-negative tabindex', async (t) => {
	const doc = installDom(t);

	const opener = doc.el('button', 'opener');
	const dialog = doc.el('div', 'chat-dialog', { tabIndex: -1, scrollTop: 120 });
	const closeBtn = doc.el('button', 'close-chat');
	const skippedNote = doc.el('div', 'programmatic-only', { tabIndex: -1 });
	const skippedBtn = doc.el('button', 'skipped-btn', { tabIndex: -1 });
	const details = doc.el('details', 'nutrition-details', { open: false });
	const summary = doc.el('summary', 'nutrition-summary');
	const hiddenInsideDetails = doc.el('button', 'inside-closed-details');
	details.append(summary, hiddenInsideDetails);
	const fixedAction = doc.el('button', 'fixed-action');
	fixedAction.style.position = 'fixed';
	const scrollRegion = doc.el('div', 'transcript-region', { tabIndex: 0 });
	dialog.append(closeBtn, skippedNote, skippedBtn, details, fixedAction, scrollRegion);
	doc.body.append(opener, dialog);
	opener.focus();

	// Start disabled: does not trap or move focus.
	const trap = focusTrap(dialog as unknown as HTMLElement, { enabled: false, key: 'step-1' });
	await flushMicrotasks();
	assert.equal(doc.activeElement, opener);

	// Enable trap: moves focus to first focusable control and excludes closed <details> children + tabindex="-1".
	trap.update({ enabled: true, key: 'step-1' });
	await flushMicrotasks();
	assert.equal(doc.activeElement, closeBtn);
	assert.deepEqual(
		focusableControls(dialog as unknown as HTMLElement).map((el) => el.id),
		['close-chat', 'nutrition-summary', 'fixed-action', 'transcript-region']
	);

	// Opening <details> exposes controls inside it.
	details.open = true;
	assert.deepEqual(
		focusableControls(dialog as unknown as HTMLElement).map((el) => el.id),
		[
			'close-chat',
			'nutrition-summary',
			'inside-closed-details',
			'fixed-action',
			'transcript-region'
		]
	);

	// Changing key resets scrollTop and re-runs initial focus.
	scrollRegion.focus();
	dialog.scrollTop = 180;
	trap.update({ enabled: true, key: 'step-2' });
	assert.equal(dialog.scrollTop, 0);
	await flushMicrotasks();
	assert.equal(doc.activeElement, closeBtn);

	// Disabling trap restores focus to opener.
	trap.update({ enabled: false, key: 'step-2' });
	await flushMicrotasks();
	assert.equal(doc.activeElement, opener);

	dialog.remove();
	trap.destroy();
});

test('node.inert deactivates outgoing modal, preserves stacked parent traps, guards external focus, and retries rAF when trigger un-inerts', async (t) => {
	const doc = installDom(t);
	const rafQueue: FrameRequestCallback[] = [];
	const prevRaf = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
	Object.defineProperty(globalThis, 'requestAnimationFrame', {
		configurable: true,
		value: (cb: FrameRequestCallback) => {
			rafQueue.push(cb);
			return rafQueue.length;
		}
	});
	t.after(() => {
		if (prevRaf) Object.defineProperty(globalThis, 'requestAnimationFrame', prevRaf);
		else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
	});

	const mainRegion = doc.el('main', 'main-shell');
	const menuBtn = doc.el('button', 'mobile-menu');
	const pageInput = doc.el('input', 'page-search');
	mainRegion.append(menuBtn, pageInput);

	const detailWrapper = doc.el('div', 'detail-wrapper');
	const detailDialog = doc.el('div', 'detail-dialog', { tabIndex: -1 });
	detailDialog.setAttribute('aria-modal', 'true');
	const detailClose = doc.el('button', 'detail-close');
	const detailSettingsTrigger = doc.el('button', 'detail-settings');
	detailDialog.append(detailClose, detailSettingsTrigger);
	detailWrapper.append(detailDialog);

	doc.body.append(mainRegion, detailWrapper);
	menuBtn.focus();

	// Open RecipeDetail; then mark its wrapper inert (NOT detailDialog.inert) and open modal1.
	const detailTrap = focusTrap(detailDialog as unknown as HTMLElement);
	await flushMicrotasks();
	detailSettingsTrigger.focus();
	const capturedDetailTrigger = activeFocusedElement();
	detailWrapper.inert = true;

	const modal1 = doc.el('div', 'settings-modal', { tabIndex: -1 });
	modal1.setAttribute('aria-modal', 'true');
	const modal1Close = doc.el('button', 'settings-close');
	modal1.append(modal1Close);
	doc.body.append(modal1);
	const trap1 = focusTrap(modal1 as unknown as HTMLElement, {
		returnFocus: capturedDetailTrigger
	});
	await flushMicrotasks();
	assert.equal(doc.activeElement, modal1Close);

	// Svelte outro marks modal1.inert = true directly while mounting modal2: modal1 loses aria-modal and hands off returnFocus, while detailDialog stays stacked.
	modal1.inert = true;
	const modal2 = doc.el('div', 'delete-modal', { tabIndex: -1 });
	modal2.setAttribute('aria-modal', 'true');
	const modal2Close = doc.el('button', 'delete-close');
	modal2.append(modal2Close);
	doc.body.append(modal2);
	const trap2 = focusTrap(modal2 as unknown as HTMLElement);
	await flushMicrotasks();

	assert.equal(modal1.getAttribute('aria-modal'), null);
	assert.equal(modal2.getAttribute('aria-modal'), 'true');
	assert.equal(detailDialog.getAttribute('aria-modal'), 'true');
	assert.equal(doc.activeElement, modal2Close);

	modal1.remove();
	trap1.destroy();

	// Closing modal2 restores focus to detailSettingsTrigger inside RecipeDetail.
	detailWrapper.inert = false;
	modal2.remove();
	trap2.destroy();
	await flushMicrotasks();
	assert.equal(doc.activeElement, detailSettingsTrigger);

	// Closing RecipeDetail while <main inert> is still set at microtask time retries on requestAnimationFrame and lands on menuBtn.
	mainRegion.inert = true;
	detailDialog.dispatchOutroStart();
	await flushMicrotasks();
	assert.equal(rafQueue.length, 1);
	mainRegion.inert = false;
	const nextFrame = rafQueue.shift()!;
	nextFrame(16);
	assert.equal(doc.activeElement, menuBtn);

	detailWrapper.remove();
	detailTrap.destroy();

	// Focusing an external page input before/during outro microtask is never overwritten by focus restoration.
	const quickModal = doc.el('div', 'quick-modal', { tabIndex: -1 });
	const quickClose = doc.el('button', 'quick-close');
	quickModal.append(quickClose);
	doc.body.append(quickModal);
	const quickTrap = focusTrap(quickModal as unknown as HTMLElement, {
		returnFocus: menuBtn as unknown as HTMLElement
	});
	await flushMicrotasks();
	assert.equal(doc.activeElement, quickClose);

	quickModal.dispatchOutroStart();
	pageInput.focus();
	await flushMicrotasks();
	assert.equal(doc.activeElement, pageInput);
	quickModal.remove();
	quickTrap.destroy();
});
