<script module lang="ts">
	const COOKED_HISTORY_PAGE_SIZE = 20;
	const MEAL_SLOTS = ['Breakfast', 'Lunch', 'Dinner'] as const;
	const weekdayFormatter = new Intl.DateTimeFormat('en', { weekday: 'short' });
	const cookedBadgeFormatter = new Intl.DateTimeFormat('en', {
		month: 'short',
		day: 'numeric'
	});
	const historyDateFormatter = new Intl.DateTimeFormat('en', {
		weekday: 'short',
		month: 'short',
		day: 'numeric'
	});

	function mealSlotKey(date: string, slot: string) {
		return `${date}:${slot}`;
	}

	function formatCompletedDate(
		value: string | undefined,
		formatter: Intl.DateTimeFormat,
		fallback = 'Unknown date'
	) {
		if (!value) return fallback;
		const timestamp = Date.parse(value);
		if (!Number.isFinite(timestamp)) return fallback;
		return formatter.format(timestamp);
	}
</script>

<script lang="ts">
	import { prepareAIPhoto } from '#lib/cover-upload.ts';
	import { recipePlaceholder, recipeImageError } from '#lib/recipe-cover.ts';
	import { onMount, tick, untrack } from 'svelte';
	import type { PageData } from './$types';
	import { revealMotion, fadeMotion, motionDuration, prefersReducedMotion } from '#lib/motion.ts';
	import { calendarDayScrollLeft, weekOffsetFromStarts } from '#lib/planner.ts';
	import { flip } from 'svelte/animate';
	import {
		ArrowRight,
		ArrowUpRight,
		Sparkles,
		LayoutGrid,
		Carrot,
		CalendarDays,
		ShoppingBasket,
		Heart,
		Settings,
		Sun,
		Moon,
		Plus,
		X,
		Mic,
		Camera,
		Search,
		Clock,
		Users,
		Bookmark,
		Check,
		ChevronLeft,
		ChevronRight,
		LogOut,
		Copy,
		Download,
		Share2,
		Leaf,
		SlidersHorizontal,
		Flame,
		ChefHat,
		Star,
		Menu,
		RefreshCw
	} from '@lucide/svelte';
	import type { AppState, Meal, Recipe, User } from '#lib/types.ts';
	import { createInitialState, createNewUserState } from '#lib/data.ts';
	import {
		buildShoppingList,
		normalizeName,
		parseIngredientLines,
		preferenceSummary
	} from '#lib/domain.ts';
	import {
		addPantryItems,
		backfillSampleData,
		clearSampleData,
		completeMeal,
		deleteShoppingItem,
		expiryStatus,
		filterPantryItems,
		hasSampleData,
		listPantryCategories,
		movePurchasesToPantry,
		normalizeIngredientName,
		normalizePantryDraft,
		promoteSampleIngredient,
		normalizeShoppingItem,
		refreshWeekShopping as refreshWeekShoppingItems,
		restockDepletedPantryItems,
		restoreShoppingItem,
		revertShoppingItem,
		shopForScope,
		snapshotShoppingItem,
		unitInfo,
		type PantryDraft,
		type ShoppingItemDraft,
		type ShoppingItemSnapshot
	} from '#lib/kitchen-workflows.ts';
	import { rankPantryRecipes, rankRecipes } from '#lib/discovery.ts';
	import {
		createBlankRecipe,
		DEFAULT_RECIPE_FILTER,
		filterTabScrollTarget,
		filterTabsOverflow,
		finalizeManualRecipe,
		hasActiveRecipeFilters,
		hasZeroNutrition,
		insertRecipes,
		resetRecipeFilterState
	} from '#lib/recipe-collection.ts';
	import ModalDialog from '#lib/components/ModalDialog.svelte';
	import MobileDrawer from '#lib/components/MobileDrawer.svelte';
	import { applyRecipeRating } from '#lib/recipe-detail.ts';
	import RecipeDetail from '#lib/components/RecipeDetail.svelte';
	import ButlerChat from '#lib/components/ButlerChat.svelte';
	import { applyButlerCommands } from '#lib/butler.ts';
	import {
		BUTLER_HISTORY_LIMIT,
		pairButlerHistory,
		type ButlerChatResult
	} from '#lib/butler-chat.ts';
	import RecipeEditor from '#lib/components/RecipeEditor.svelte';
	import SyncStatus from '#lib/components/SyncStatus.svelte';
	import ToggleButton from '#lib/components/ToggleButton.svelte';
	import AIConnection from '#lib/components/AIConnection.svelte';
	import VoiceSettings from '#lib/components/VoiceSettings.svelte';
	import {
		appendDictatedText,
		isVoiceTargetActive,
		parseQuickShoppingItems,
		planVoiceRetry,
		planVoiceStart,
		resolveClosedDialog,
		VoiceCapture,
		type ResumeDialog,
		type VoiceState,
		type VoiceTarget
	} from '#lib/voice-capture.ts';
	import { voiceProviders, type VoiceProvider } from '#lib/voice-config.ts';
	import {
		CHATGPT_OAUTH_POLL_INTERVAL_MS,
		CHATGPT_OAUTH_TTL_MS,
		HOST_CONNECTION_ID,
		startConnectionPoll,
		type ConnectionModel,
		type ConnectionPollHandle,
		type ConnectionProvider
	} from '#lib/ai-connections.ts';
	import {
		entitledChatGPTAccountId,
		reconcileChatGPTPreferences,
		runConcurrentModelCatalog,
		runHouseholdTransition,
		runOpenSettingsWorkflow,
		runReconnectWorkflow,
		runSignedInHydration
	} from '#lib/client-workflows.ts';
	import {
		clearGuestData,
		clearGuestKitchen,
		quarantineLegacyKitchen,
		sanitizeKitchenState
	} from '#lib/guest-storage.ts';
	import { exportKitchenArchive } from '#lib/kitchen-export.ts';
	import { createKitchenSync } from '#lib/client-sync.ts';
	import type { SyncConflict } from '#lib/offline-sync.ts';
	import RecipeImport, {
		emptyImportSession,
		type ImportSession
	} from '#lib/components/RecipeImport.svelte';
	import { isStandaloneRecipeUrl } from '#lib/recipe-scraper.ts';
	import {
		applyImportedRecipeSave,
		canAppendImportTranscript,
		cloneImportSession,
		isReviewingImportDraft,
		replaceImportSessionWithUrl
	} from '#lib/import-session.ts';
	import { isValidServings, MAX_SERVINGS } from '#lib/recipe-draft.ts';
	type AuthMode = 'local' | 'oidc' | 'proxy' | 'invalid';
	let { data }: { data: PageData } = $props();
	let kitchen = $state<AppState>(createInitialState());
	let hasSampleRecords = $state(true);
	let user = $state<User | null>(null);
	let ready = $state(false);
	let kitchenLoaded = $state(false);
	let runtimeAuthMode = $state<AuthMode | null>(null);
	let installationAuthMode = $derived(runtimeAuthMode ?? data.authMode);
	let managedAuth = $derived(installationAuthMode !== 'local');
	let authMetadataLoaded = $state(false);
	let guestPersistenceReady = $state(false);
	let runtimeLoginUrl = $state<string | null>(null);
	let runtimeLogoutUrl = $state<string | null>(null);
	let providerLoginUrl = $derived(authMetadataLoaded ? runtimeLoginUrl : data.loginUrl);
	let providerLogoutUrl = $derived(authMetadataLoaded ? runtimeLogoutUrl : data.logoutUrl);
	let online = $state(true);
	let syncReady = $state(false);
	let pendingSync = $state(false);
	let sendingSync = $state(false);
	let syncErrors = $state('');
	let conflicts = $state<SyncConflict[]>([]);
	let reviewedEtag = $state<string | null>(null);
	let kitchenSync: ReturnType<typeof createKitchenSync> | undefined;
	const PANTRY_FILTER = 'From my pantry';
	let page = $state('discover');
	let filter = $state(DEFAULT_RECIPE_FILTER);
	let priorityPantryIds = $state<string[]>([]);
	let query = $state('');
	let showHiddenRecipes = $state(false);
	let lastActivePill = $state<'filter' | 'hidden'>('filter');
	let filterTabs = $state<HTMLDivElement | null>(null);
	let filterOverflow = $state({ left: false, right: false });
	let activeRecipeFilters = $derived(hasActiveRecipeFilters({ filter, query, showHiddenRecipes }));
	function syncFilterOverflow() {
		if (!filterTabs) {
			filterOverflow = { left: false, right: false };
			return;
		}
		filterOverflow = filterTabsOverflow({
			scrollLeft: filterTabs.scrollLeft,
			clientWidth: filterTabs.clientWidth,
			scrollWidth: filterTabs.scrollWidth
		});
	}
	function resetRecipeFilters() {
		const next = resetRecipeFilterState();
		lastActivePill = 'filter';
		priorityPantryIds = [];
		filter = next.filter;
		query = next.query;
		showHiddenRecipes = next.showHiddenRecipes;
	}
	$effect(() => {
		const currentPage = page;
		const currentFilter = filter;
		const currentHidden = showHiddenRecipes;
		const preferred = lastActivePill;
		const container = filterTabs;
		if ((currentPage !== 'discover' && currentPage !== 'saved') || !container) return;
		let cancelled = false;
		void tick().then(() => {
			if (cancelled || filterTabs !== container) return;
			const targetKey =
				preferred === 'hidden' && currentHidden
					? 'hidden'
					: currentFilter !== DEFAULT_RECIPE_FILTER
						? currentFilter
						: currentHidden
							? 'hidden'
							: DEFAULT_RECIPE_FILTER;
			const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
			const pill = buttons.find((button) => button.dataset.filter === targetKey);
			if (pill) {
				const containerRect = container.getBoundingClientRect();
				const pillRect = pill.getBoundingClientRect();
				const pillLeft = pillRect.left - containerRect.left + container.scrollLeft;
				const left = filterTabScrollTarget({
					clientWidth: container.clientWidth,
					scrollWidth: container.scrollWidth,
					pillLeft,
					pillWidth: pillRect.width
				});
				if (Math.abs(container.scrollLeft - left) > 1) {
					container.scrollTo({
						left,
						behavior: prefersReducedMotion() ? 'instant' : 'smooth'
					});
				}
			}
			syncFilterOverflow();
		});
		return () => {
			cancelled = true;
		};
	});
	$effect(() => {
		const container = filterTabs;
		if (!container || typeof window === 'undefined') return;
		syncFilterOverflow();
		const observer =
			typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => syncFilterOverflow()) : null;
		observer?.observe(container);
		window.addEventListener('resize', syncFilterOverflow);
		void document.fonts?.ready?.then(() => {
			if (filterTabs === container) syncFilterOverflow();
		});
		return () => {
			observer?.disconnect();
			window.removeEventListener('resize', syncFilterOverflow);
		};
	});
	let toast = $state('');
	let toastUndo = $state<(() => void) | null>(null);
	let toastActionLabel = $state('Undo');
	let toastVersion = 0;
	let exporting = $state(false);
	let busy = $state(false);
	let scanBusy = $state(false);
	let scanController: AbortController | undefined;
	let scanGeneration = 0;
	function cancelScan(silent = false) {
		if (!scanBusy) return;
		scanGeneration++;
		scanController?.abort();
		scanController = undefined;
		scanBusy = false;
		if (imageInput) imageInput.value = '';
		if (!silent) notify('Photo scan cancelled.');
	}
	let mobileNav = $state(false);
	let mobileViewport = $state(false);
	let mobileMenuButton = $state<HTMLButtonElement | null>(null);
	let mobileDrawerOpen = $derived(mobileViewport && mobileNav);
	let mobileCalendar = $state(
		typeof window !== 'undefined' &&
			typeof window.matchMedia === 'function' &&
			window.matchMedia('(max-width: 650px)').matches
	);
	let modal = $state('');
	const dialogNames: Record<string, string> = {
		onboarding: 'Recipe preferences',
		import: 'Import recipe',
		pantry: 'Add pantry ingredients',
		auth: 'Sign in or create an account',
		generate: 'Generate recipes',
		settings: 'Settings',
		household: 'Your household',
		confirmJoin: 'Replace personal kitchen',
		removeMember: 'Remove household member',
		leave: 'Leave household',
		delete: 'Delete account',
		recover: 'Recover your account',
		reset: 'Reset password',
		deleteRecipe: 'Delete recipe',
		editMeal: 'Edit planned meal',
		cookMeal: 'Complete cooking',
		plan: 'Plan a meal',
		pickRecipe: 'Choose a recipe',
		taste: 'Recipe preferences',
		search: 'Find recipes online'
	};
	let quizTime = $state(45);
	let quizComplexity = $state('Easy');
	let quizCuisines = $state<string[]>([]);
	let quizDiet = $state('none');
	let quizAllergies = $state('');
	const cuisineChoices = [
		'Mediterranean',
		'Italian',
		'Mexican',
		'Indian',
		'Japanese',
		'Thai',
		'Middle Eastern',
		'American'
	];
	function openOnboarding() {
		quizTime = kitchen.preferences.maxTime;
		quizComplexity = kitchen.preferences.complexity;
		quizCuisines = [...(kitchen.preferences.cuisines ?? [])];
		quizDiet = kitchen.preferences.diet;
		quizAllergies = kitchen.preferences.allergies;
		modal = 'onboarding';
	}
	function openAuthentication() {
		if (installationAuthMode === 'oidc') {
			window.location.assign(providerLoginUrl ?? '/auth/login');
			return;
		}
		if (installationAuthMode === 'proxy') {
			window.location.reload();
			return;
		}
		if (installationAuthMode === 'invalid') {
			notify('Sign-in is unavailable because authentication is misconfigured.');
			return;
		}
		mobileNav = false;
		modal = 'auth';
	}
	function clearHouseholdViewState() {
		selected = null;
		selectedMealServings = undefined;
		editingRecipe = null;
		editingRecipeMode = 'edit';
		recipeToDelete = null;
		resetMealDialogState();
		pantryDraft = null;
		editingShoppingId = '';
		editingShoppingDraft = null;
		shoppingFilter = 'all';
		cookedHistoryLimit = COOKED_HISTORY_PAGE_SIZE;
	}
	function saveLastAccount(account: User) {
		if (managedAuth) return;
		try {
			localStorage.setItem('flavorithm-last-account', JSON.stringify(account));
		} catch {}
	}
	function clearManagedIdentity() {
		cancelScan(true);
		clearVoiceSession();
		pantryInput = '';
		resumeDialog = '';
		clearAIConnectionState();
		clearHouseholdViewState();
		kitchenSync?.clearContext();
		user = null;
		editingRecipe = null;
		editingRecipeMode = 'edit';
		kitchen = createInitialState();
		hasSampleRecords = true;
		cookedHistoryLimit = COOKED_HISTORY_PAGE_SIZE;
		kitchenLoaded = false;
		showStarter = false;
		stateEtag = null;
		localStorage.removeItem('flavorithm-last-account');
		clearGuestData(localStorage);
		quarantineLegacyKitchen(localStorage);
		members = [];
		householdInvites = [];
		canManageHousehold = false;
		inviteCode = '';
		currentInviteId = '';
		joinCode = '';
		pantryDraft = null;
		resetPantryFilters();
	}
	function renewManagedSession(error: unknown) {
		if (!navigator.onLine || (error as { status?: number })?.status !== 401) return;
		if (installationAuthMode === 'oidc') window.location.assign('/auth/login');
		else if (installationAuthMode === 'proxy') window.location.reload();
	}
	function updateAuthMetadata(data: Record<string, unknown>) {
		if (
			data.authMode === 'local' ||
			data.authMode === 'oidc' ||
			data.authMode === 'proxy' ||
			data.authMode === 'invalid'
		) {
			runtimeAuthMode = data.authMode;
		}
		runtimeLoginUrl = typeof data.loginUrl === 'string' ? data.loginUrl : null;
		runtimeLogoutUrl = typeof data.logoutUrl === 'string' ? data.logoutUrl : null;
		authMetadataLoaded = 'loginUrl' in data && 'logoutUrl' in data;
	}
	function dismissOnboarding() {
		if (!kitchen.preferences.onboardingStatus) kitchen.preferences.onboardingStatus = 'skipped';
		modal = '';
	}
	function finishOnboarding(event: SubmitEvent) {
		event.preventDefault();
		Object.assign(kitchen.preferences, {
			maxTime: quizTime,
			complexity: quizComplexity,
			cuisines: [...quizCuisines],
			diet: quizDiet,
			allergies: quizAllergies.trim(),
			onboardingStatus: 'completed'
		});
		modal = '';
		notify('Preferences saved.');
	}

	let selected = $state<Recipe | null>(null);
	let editingRecipe = $state<Recipe | null>(null);
	let editingRecipeMode = $state<'create' | 'edit'>('edit');
	let recipeToDelete = $state<Recipe | null>(null);
	let pantryInput = $state('');
	let authMode = $state('register');
	let name = $state('');
	let email = $state('');
	let password = $state('');
	let error = $state('');
	let apiKey = $state('');
	let voiceProvider = $state<VoiceProvider>('auto');
	let voiceModel = $state('');
	let voiceApiKey = $state('');
	let localVoiceAvailable = $state(false);
	let voiceState = $state<VoiceState>('idle');
	let voiceStarting = $state(false);
	let voiceRetained = $state(false);
	let voiceError = $state('');
	let voiceBusy = $derived(voiceStarting || voiceState !== 'idle');
	let voiceTarget = $state<VoiceTarget | ''>('');
	let shoppingVoiceInput = $state(false);
	let shoppingMicButton = $state<HTMLButtonElement>();
	let pantryVoiceButton = $state<HTMLButtonElement>();
	let voiceSessionEl = $state<HTMLDivElement>();
	let voiceStopButton = $state<HTMLButtonElement>();
	let voiceCancelButton = $state<HTMLButtonElement>();
	let voiceRetryButton = $state<HTMLButtonElement>();
	let voiceReturnFocus: HTMLElement | null = null;
	let voiceCapture: VoiceCapture | undefined;
	let activeVoiceImportSession: ImportSession | undefined;
	let voiceOwner = $derived(user?.id ?? '');
	$effect(() => {
		const owner = voiceOwner;
		if (typeof window === 'undefined') return;
		untrack(() => {
			clearVoiceSession(false);
			shoppingVoiceInput = false;
			voiceApiKey = '';
			voiceProvider = 'auto';
			voiceModel = '';
			localVoiceAvailable = false;
		});
		if (owner) {
			try {
				const saved = JSON.parse(localStorage.getItem(`flavorithm-voice:${owner}`) || '{}');
				const spec = voiceProviders.find((item) => item.id === saved.provider);
				if (spec) {
					voiceProvider = spec.id;
					voiceModel =
						'models' in spec
							? (spec.models as readonly string[]).includes(saved.model)
								? saved.model
								: spec.models[0]
							: '';
				}
			} catch {}
			fetch('/api/voice')
				.then((r) => (r.ok ? r.json() : null))
				.then((data) => {
					if (user?.id === owner) localVoiceAvailable = Boolean(data?.localAvailable);
				})
				.catch(() => {});
		}
		return () => untrack(() => clearVoiceSession(false));
	});
	type AccountCapabilities = { emailDelivery: boolean; recipeSearch: boolean };
	let capabilities = $state<AccountCapabilities>({ emailDelivery: false, recipeSearch: false });
	let verificationBusy = $state(false);
	type ChatGPTAccount = {
		id: string;
		label: string;
		email?: string;
		subject?: string;
		planEnabled: boolean;
		connected: boolean;
		updatedAt?: number;
	};
	let chatGPT = $state<{
		hostAdmin?: boolean;
		host?: { model: string } | null;
		configured: boolean;
		mode: string;
		safeReason?: string;
		accounts: ChatGPTAccount[];
	}>({ configured: false, mode: 'unavailable', accounts: [] });
	let connectionBusy = $state(false);
	let connectionActive = $state(false);
	let chatGPTAuthorizationUrl = $state('');
	let chatGPTDevice = $state<{
		loginId: string;
		userCode: string;
		verificationUrl: string;
		expiresAt: number;
		interval: number;
	} | null>(null);
	let connectionPoll: ConnectionPollHandle | undefined;
	let connectionPopup: Window | null = null;
	let connectionAttempt = 0;
	let personalChatGPTAccounts = $derived(
		chatGPT.accounts.filter((a) => a.id !== HOST_CONNECTION_ID)
	);
	let activeChatGPTAccount = $derived(
		personalChatGPTAccounts.find((a) => a.id === kitchen.preferences.chatgptAccountId)
	);
	let usingHostAI = $derived(Boolean(chatGPT.host && !kitchen.preferences.usePersonalAI));
	$effect(() => {
		if (modal !== 'settings' && (connectionActive || chatGPTDevice || chatGPTAuthorizationUrl)) {
			void cancelChatGPTDevice();
		}
	});

	let providers = $state<ConnectionProvider[]>([]);
	let accountModels = $state<ConnectionModel[]>([]);
	let catalogLoading = $state(false);
	let catalogError = $state('');
	let catalogVersion = 0;
	let prompt = $state('');
	let importSession = $state<ImportSession>(emptyImportSession());
	let resumeDialog = $state<ResumeDialog>('');
	let searchResults = $state<{ title: string; url: string; description: string }[]>([]);
	type HouseholdMember = { id: string; name: string; email: string; role: string };
	type HouseholdInvite = { inviteId: string; expiresAt: number };
	let members = $state<HouseholdMember[]>([]);
	let householdInvites = $state<HouseholdInvite[]>([]);
	let canManageHousehold = $state(false);
	let householdBusy = $state(false);
	let memberToRemove = $state<HouseholdMember | null>(null);
	let inviteCode = $state('');
	let currentInviteId = $state('');
	let joinCode = $state('');
	let weekOffset = $state(0);
	let calendarGrid = $state<HTMLDivElement | undefined>();
	let previousPage = '';
	let pendingPlannerScrollDate = '';
	let calendarScrollToken = 0;
	let cookedHistoryLimit = $state(COOKED_HISTORY_PAGE_SIZE);
	let mealDate = $state('');
	let mealSlot = $state('Dinner');
	let plannedServings = $state(2);
	let pickingForSlot = $state(false);
	let editingMealId = $state('');
	let cookingMealId = $state('');
	let deductPantry = $state(false);
	let leftoverServings = $state(0);
	let pantryFilter = $state('all');
	let pantryQuery = $state('');
	let pantryCategory = $state('all');
	let pantryDraft = $state<PantryDraft | null>(null);
	let shoppingFilter = $state<'all' | 'unpurchased'>('all');
	let shoppingText = $state('');
	let editingShoppingId = $state('');
	let editingShoppingDraft = $state<(ShoppingItemDraft & { id: string }) | null>(null);
	let editingShoppingSnapshot = $state<ShoppingItemSnapshot | null>(null);
	let deletePassword = $state('');
	let resetToken = $state('');
	let showStarter = $state(true);
	let imageInput: HTMLInputElement;
	let deferredInstall = $state<any>(null);
	async function refreshAuth() {
		const data = await request('/api/auth');
		const previousMode = installationAuthMode;
		const previousUser = user;
		updateAuthMetadata(data);
		capabilities = {
			emailDelivery: Boolean(data.capabilities?.emailDelivery),
			recipeSearch: Boolean(data.capabilities?.recipeSearch)
		};
		if (modal === 'recover' && !capabilities.emailDelivery) modal = 'auth';
		const nextUser: User | null = data.user ?? null;
		const modeChanged = previousMode !== installationAuthMode;
		const changedIdentity =
			Boolean(previousUser) !== Boolean(nextUser) ||
			Boolean(
				previousUser &&
				nextUser &&
				(previousUser.id !== nextUser.id || previousUser.householdId !== nextUser.householdId)
			) ||
			Boolean(modeChanged && managedAuth && nextUser);
		if (modeChanged && managedAuth) clearManagedIdentity();
		if (changedIdentity) {
			cancelScan(true);
			kitchenSync?.clearContext();
			clearAIConnectionState();
			clearHouseholdViewState();
			stateEtag = null;
			if (nextUser) kitchen = createNewUserState();
		}
		user = nextUser;
		if (managedAuth && !user) {
			clearManagedIdentity();
			renewManagedSession({ status: 401 });
		}
		let stateLoaded = false;
		if (changedIdentity) {
			if (user) {
				const snapshotUser = $state.snapshot(user);
				showStarter = false;
				kitchenSync?.prepare(snapshotUser);
				kitchenLoaded = true;
				saveLastAccount(snapshotUser);
				try {
					const latest = await request('/api/state');
					adoptKitchen(latest.state || createNewUserState());
					kitchenLoaded = true;
					stateLoaded = true;
					if (online && kitchenSync?.snapshot()) await retrySync();
				} catch (e) {
					kitchenSync?.failLoad((e as Error).message);
					throw e;
				}
			} else if (managedAuth) {
				clearManagedIdentity();
			} else {
				kitchen = createInitialState();
				hasSampleRecords = true;
				localStorage.removeItem('flavorithm-last-account');
				kitchenLoaded = true;
			}
		} else if (user && !syncReady) {
			const snapshotUser = $state.snapshot(user);
			showStarter = false;
			kitchenSync?.prepare(snapshotUser);
			kitchenLoaded = true;
			saveLastAccount(snapshotUser);
			try {
				const latest = await request('/api/state');
				adoptKitchen(latest.state || createNewUserState());
				kitchenLoaded = true;
				stateLoaded = true;
				if (online && kitchenSync?.snapshot()) await retrySync();
			} catch (e) {
				kitchenSync?.failLoad((e as Error).message);
				throw e;
			}
		}
		return { ...data, stateLoaded };
	}
	const nav = [
		{ id: 'discover', name: 'Discover', icon: LayoutGrid },
		{ id: 'pantry', name: 'My pantry', icon: Carrot },
		{ id: 'planner', name: 'Meal planner', icon: CalendarDays },
		{ id: 'shopping', name: 'Shopping list', icon: ShoppingBasket },
		{ id: 'saved', name: 'Recipe collection', icon: Heart }
	];
	const themes = [
		'catppuccin',
		'cerberus',
		'concord',
		'crimson',
		'dracula',
		'fennec',
		'hamlindigo',
		'legacy',
		'mint',
		'modern',
		'mona',
		'nosh',
		'nouveau',
		'pine',
		'reign',
		'rocket',
		'rose',
		'rosepine',
		'sahara',
		'seafoam',
		'terminus',
		'vintage',
		'vox',
		'wintry'
	];
	let activePriorityPantry = $derived(
		priorityPantryIds.length
			? kitchen.pantry.filter(
					(item) =>
						priorityPantryIds.includes(item.id) &&
						Number.isFinite(item.quantity) &&
						item.quantity > 0 &&
						expiryStatus(item.expires) !== 'expired' &&
						!(Boolean(item.expires?.trim()) && expiryStatus(item.expires) === 'unknown')
				)
			: []
	);
	let recipes = $derived.by(() => {
		const matches = kitchen.recipes.filter(
			(r) =>
				(page !== 'saved' || r.saved) &&
				(showHiddenRecipes || !r.hidden) &&
				(!query ||
					`${r.title} ${r.cuisine} ${r.tags.join(' ')}`
						.toLowerCase()
						.includes(query.toLowerCase())) &&
				(filter !== 'Quick & easy' || r.time <= 30) &&
				(filter !== 'Plant-powered' || r.tags.some((t) => /vegetarian|vegan|plant/i.test(t))) &&
				(filter !== 'Comfort food' || r.tags.some((t) => /comfort/i.test(t))) &&
				(filter !== 'High protein' || (!r.nutritionStale && r.nutrition.protein >= 25))
		);
		if (filter === PANTRY_FILTER) {
			return rankPantryRecipes(
				matches,
				kitchen.pantry,
				kitchen.preferences,
				activePriorityPantry.length ? activePriorityPantry : undefined
			);
		}
		return filter === 'For you'
			? rankRecipes(matches, kitchen.pantry, kitchen.preferences)
			: matches.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
	});
	let visiblePantry = $derived(
		filterPantryItems(kitchen.pantry, {
			query: pantryQuery,
			category: pantryCategory,
			expiry: pantryFilter
		})
	);
	let pantryCategories = $derived(listPantryCategories(kitchen.pantry, pantryCategory));
	let pantryCategorySuggestions = $derived(
		[
			'Produce',
			'Grains',
			'Oils & condiments',
			'Canned goods',
			'Dairy & eggs',
			'Spices',
			'Pantry',
			...pantryCategories.map((entry) => entry.label)
		].filter(
			(label, index, all) =>
				all.findIndex((candidate) => candidate.toLowerCase() === label.toLowerCase()) === index
		)
	);
	$effect(() => {
		if (pantryDraft && !kitchen.pantry.some((item) => item.id === pantryDraft?.id)) {
			pantryDraft = null;
		}
	});
	async function startPantryEdit(item: AppState['pantry'][number]) {
		pantryDraft = {
			id: item.id,
			quantity: item.quantity,
			unit: item.unit,
			category: item.category.trim() || 'Pantry',
			expires: item.expires ?? ''
		};
		await tick();
		document.querySelector<HTMLInputElement>('.pantry-row.editing input[type="number"]')?.focus();
	}
	async function savePantryEdit(restoreFocus = true) {
		const draft = pantryDraft;
		if (!draft) return;
		const normalized = normalizePantryDraft(draft);
		kitchen.pantry = kitchen.pantry.map((item) => {
			if (item.id !== draft.id) return item;
			const currentCategory = item.category.trim() || 'Pantry';
			const currentExpires = item.expires?.trim().slice(0, 50) || undefined;
			const changed =
				item.quantity !== normalized.quantity ||
				item.unit !== normalized.unit ||
				currentCategory !== normalized.category ||
				currentExpires !== normalized.expires;
			const updated: AppState['pantry'][number] = {
				...(changed ? promoteSampleIngredient(item) : item),
				id: item.id,
				name: item.name,
				quantity: normalized.quantity,
				unit: normalized.unit,
				category: normalized.category
			};
			if (normalized.expires) updated.expires = normalized.expires;
			else delete updated.expires;
			return updated;
		});
		hasSampleRecords = hasSampleData(kitchen);
		const editedId = draft.id;
		pantryDraft = null;
		if (!restoreFocus) return;
		await tick();
		document
			.querySelector<HTMLButtonElement>(`[data-pantry-edit="${CSS.escape(editedId)}"]`)
			?.focus();
	}
	async function cancelPantryEdit() {
		const editedId = pantryDraft?.id;
		pantryDraft = null;
		if (editedId) {
			await tick();
			document
				.querySelector<HTMLButtonElement>(`[data-pantry-edit="${CSS.escape(editedId)}"]`)
				?.focus();
		}
	}
	function handlePantryInputKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			void cancelPantryEdit();
		} else if (event.key === 'Enter') {
			event.preventDefault();
			void savePantryEdit();
		}
	}
	function removePantryItem(item: AppState['pantry'][number]) {
		if (pantryDraft?.id === item.id) pantryDraft = null;
		kitchen.pantry = kitchen.pantry.filter((entry) => entry.id !== item.id);
		hasSampleRecords = hasSampleData(kitchen);
	}
	function resetPantryFilters() {
		pantryQuery = '';
		pantryCategory = 'all';
		pantryFilter = 'all';
	}
	function expiryBadgeLabel(status: ReturnType<typeof expiryStatus>) {
		return status === 'expired'
			? 'Expired'
			: status === 'soon'
				? 'Use soon'
				: status === 'fresh'
					? 'In date'
					: 'No date';
	}
	let availablePantryNames = $derived(
		new Set(
			kitchen.pantry
				.filter(
					(item) =>
						Number.isFinite(item.quantity) &&
						item.quantity > 0 &&
						expiryStatus(item.expires) !== 'expired' &&
						!(Boolean(item.expires?.trim()) && expiryStatus(item.expires) === 'unknown')
				)
				.map((item) => normalizeName(item.name))
				.filter(Boolean)
		)
	);
	let checkedCount = $derived(kitchen.shopping.filter((item) => item.checked).length);
	let visibleShopping = $derived(
		shoppingFilter === 'unpurchased'
			? kitchen.shopping.filter((item) => !item.checked)
			: kitchen.shopping
	);
	let week = $derived.by(() => {
		const d = new Date();
		d.setHours(12, 0, 0, 0);
		d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + weekOffset * 7);
		return Array.from({ length: 7 }, (_, i) => {
			const date = new Date(d);
			date.setDate(d.getDate() + i);
			return date;
		});
	});
	let recipesById = $derived(new Map(kitchen.recipes.map((recipe) => [recipe.id, recipe])));
	let plannerMeals = $derived.by(() => {
		const byDateSlot = new Map<string, Meal[]>();
		const completed: Meal[] = [];
		for (const meal of kitchen.meals) {
			const slotKey = mealSlotKey(meal.date, meal.slot);
			const bucket = byDateSlot.get(slotKey);
			if (bucket) bucket.push(meal);
			else byDateSlot.set(slotKey, [meal]);
			if (meal.completedAt) completed.push(meal);
		}
		completed.sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
		return { mealsByDateSlot: byDateSlot, completedMeals: completed };
	});
	let mealsByDateSlot = $derived(plannerMeals.mealsByDateSlot);
	let completedMeals = $derived(plannerMeals.completedMeals);
	let renderableCompletedMeals = $derived(
		completedMeals.filter((meal) => recipesById.has(meal.recipeId))
	);
	let visibleCompletedMeals = $derived(renderableCompletedMeals.slice(0, cookedHistoryLimit));
	function ingredientEmoji(name: string) {
		return /tomato/i.test(name)
			? '🍅'
			: /lemon/i.test(name)
				? '🍋'
				: /spinach|basil|kale/i.test(name)
					? '🌿'
					: /egg/i.test(name)
						? '🥚'
						: '✳';
	}
	function dateKey(date: Date) {
		return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
	}
	function notify(message: string, undo?: () => void, actionLabel = 'Undo') {
		toast = message;
		const owner = `${user?.id ?? 'guest'}:${user?.householdId ?? ''}`;
		toastActionLabel = undo ? actionLabel : 'Undo';
		toastUndo = undo
			? () => {
					toastUndo = null;
					toastActionLabel = 'Undo';
					toast = '';
					if (owner === `${user?.id ?? 'guest'}:${user?.householdId ?? ''}`) undo();
				}
			: null;
		const version = ++toastVersion;
		setTimeout(
			() => {
				if (toastVersion === version) {
					toast = '';
					toastUndo = null;
					toastActionLabel = 'Undo';
				}
			},
			undo ? 10000 : 4200
		);
	}
	function applyShoppingEdit(item: AppState['shopping'][number]) {
		normalizeShoppingItem(item, editingShoppingDraft?.id === item.id ? editingShoppingDraft : null);
	}
	function clearEditingShoppingState() {
		editingShoppingId = '';
		editingShoppingDraft = null;
		editingShoppingSnapshot = null;
	}
	async function startEditingShoppingItem(item: AppState['shopping'][number]) {
		if (editingShoppingId && editingShoppingId !== item.id) {
			const active = kitchen.shopping.find((entry) => entry.id === editingShoppingId);
			if (active) applyShoppingEdit(active);
		}
		editingShoppingSnapshot = snapshotShoppingItem(item);
		editingShoppingId = item.id;
		editingShoppingDraft = {
			id: item.id,
			name: item.name,
			quantity: item.quantity,
			unit: item.unit
		};
		await tick();
		document
			.querySelector<HTMLInputElement>(`[data-shopping-name="${CSS.escape(item.id)}"]`)
			?.focus();
	}
	async function finishEditingShoppingItem(item: AppState['shopping'][number]) {
		const id = item.id;
		applyShoppingEdit(item);
		clearEditingShoppingState();
		await tick();
		document.querySelector<HTMLButtonElement>(`[data-shopping-edit="${CSS.escape(id)}"]`)?.focus();
	}
	async function cancelEditingShoppingItem() {
		const id = editingShoppingId;
		if (!id) return;
		const active = kitchen.shopping.find((entry) => entry.id === id);
		if (active && editingShoppingSnapshot) revertShoppingItem(active, editingShoppingSnapshot);
		clearEditingShoppingState();
		await tick();
		document.querySelector<HTMLButtonElement>(`[data-shopping-edit="${CSS.escape(id)}"]`)?.focus();
	}
	function removeShoppingItem(item: AppState['shopping'][number]) {
		if (editingShoppingId === item.id) clearEditingShoppingState();
		const removed = structuredClone($state.snapshot(item));
		kitchen.shopping = deleteShoppingItem(kitchen, removed.id);
		if (editingShoppingId && !kitchen.shopping.some((entry) => entry.id === editingShoppingId))
			clearEditingShoppingState();
		notify(`${item.name} removed.`, () => {
			if (editingShoppingId === removed.id) clearEditingShoppingState();
			kitchen.shopping = restoreShoppingItem(kitchen, removed);
			if (editingShoppingId && !kitchen.shopping.some((entry) => entry.id === editingShoppingId))
				clearEditingShoppingState();
		});
	}
	function consumeLeftoverServing(meal: Meal) {
		const previous = meal.leftoverServings ?? 0;
		if (!(previous > 0)) return;
		const mealId = meal.id;
		const next = Math.max(0, Math.round((previous - 1) * 100) / 100);
		meal.leftoverServings = next;
		notify(
			next > 0
				? `1 leftover serving used · ${next} remaining.`
				: 'Last leftover serving marked used.',
			() => {
				const target = kitchen.meals.find((entry) => entry.id === mealId);
				if (target && target.leftoverServings === next) target.leftoverServings = previous;
				else notify('Leftovers changed again. Review the current count before editing.');
			}
		);
	}
	function clearMealLeftovers(meal: Meal) {
		const previous = meal.leftoverServings ?? 0;
		if (!(previous > 0)) return;
		const mealId = meal.id;
		meal.leftoverServings = 0;
		notify('Leftovers marked used.', () => {
			const target = kitchen.meals.find((entry) => entry.id === mealId);
			if (target && target.leftoverServings === 0) target.leftoverServings = previous;
			else notify('Leftovers changed again. Review the current count before editing.');
		});
	}
	function removePlannedMeal(meal: Meal) {
		const removed = structuredClone($state.snapshot(meal));
		kitchen.meals = kitchen.meals.filter((entry) => entry.id !== meal.id);
		hasSampleRecords = hasSampleData(kitchen);
		refreshWeekShopping(weekStartForDate(meal.date));
		notify('Planned meal removed.', () => {
			if (
				kitchen.recipes.some((recipe) => recipe.id === removed.recipeId) &&
				!kitchen.meals.some((entry) => entry.id === removed.id)
			) {
				kitchen.meals.push(removed);
				hasSampleRecords = hasSampleData(kitchen);
				refreshWeekShopping(weekStartForDate(removed.date));
			}
		});
	}
	async function request(url: string, body?: unknown, method = 'POST', signal?: AbortSignal) {
		const headers: Record<string, string> =
			body === undefined ? {} : { 'Content-Type': 'application/json' };
		if (url === '/api/state' && method === 'PUT') {
			if (stateEtag) headers['If-Match'] = stateEtag;
			else headers['If-None-Match'] = '*';
		}
		const response = await fetch(url, {
			signal,
			method: body === undefined ? 'GET' : method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		if (managedAuth && response.redirected) {
			clearManagedIdentity();
			renewManagedSession({ status: 401 });
			throw new Error('Your organization session needs to be renewed.');
		}
		let data: any;
		try {
			data = await response.json();
		} catch (error) {
			if (managedAuth && (response.status === 401 || response.status === 403)) {
				clearManagedIdentity();
				renewManagedSession({ status: 401 });
			}
			throw error;
		}
		if (!response.ok) {
			if (response.status === 401 && managedAuth) {
				clearManagedIdentity();
				renewManagedSession({ status: 401 });
			}
			if (response.status === 412 || response.status === 428) {
				clearTimeout(saveTimer);
				void reconnectKitchen();
				notify('Your household changed in another tab. Checking for updates.');
			}
			throw Object.assign(new Error(data.error || 'Something went wrong. Please try again.'), {
				status: response.status,
				code: data.code
			});
		}
		if (url === '/api/state') stateEtag = data.state ? response.headers.get('etag') : null;
		return data;
	}

	let syncing = $state(false);
	$effect(() => {
		page;
		if (ready) window.scrollTo({ top: 0, behavior: 'instant' });
	});
	$effect(() => {
		const currentPage = page;
		const enteringPlanner = currentPage === 'planner' && previousPage !== 'planner';
		previousPage = currentPage;
		if (!enteringPlanner) return;
		if (pendingPlannerScrollDate) {
			pendingPlannerScrollDate = '';
			return;
		}
		if (untrack(() => weekOffset === 0)) {
			void scrollCalendarToDate(dateKey(new Date()), true);
		}
	});
	let stateEtag: string | null = null;
	let writeChain = Promise.resolve();
	let saveTimer: ReturnType<typeof setTimeout>;
	$effect(() => {
		const rawSnapshot = JSON.stringify(kitchen);
		if (!ready) return;
		document.documentElement.dataset.theme = kitchen.preferences.theme;
		document.documentElement.classList.toggle('dark', kitchen.preferences.dark);
		if (managedAuth && (!user || !kitchenLoaded)) return;
		const sanitized = sanitizeKitchenState(JSON.parse(rawSnapshot));
		if (!managedAuth && !user && guestPersistenceReady) {
			try {
				localStorage.setItem('flavorithm-guest-kitchen', JSON.stringify(sanitized));
			} catch {
				notify(
					'Device storage is full. Export your kitchen before leaving.',
					() => {
						void exportKitchen();
					},
					'Export now'
				);
			}
		}
		if (user) kitchenSync?.stage(sanitized);
		clearTimeout(saveTimer);
		if (user && pendingSync && !syncing && !syncErrors && online)
			saveTimer = setTimeout(() => {
				void retrySync();
			}, 500);
	});
	onMount(() => {
		online = navigator.onLine;
		kitchenSync = createKitchenSync({
			storage: localStorage,
			getUser: () => user,
			getState: () => sanitizeKitchenState(JSON.parse(JSON.stringify(kitchen))),
			setState: (state) => {
				const sanitized = sanitizeKitchenState(state);
				kitchen = sanitized;
				hasSampleRecords = hasSampleData(sanitized);
			},
			onStatus: (status) => {
				syncReady = status.ready;
				pendingSync = status.pending;
				sendingSync = status.syncing;
				conflicts = status.conflicts;
				reviewedEtag = status.reviewedEtag;
				syncErrors = status.error;
			},
			transport: (owner) => ({
				identity: { userId: owner.id, householdId: owner.householdId },
				get: async () => {
					const response = await fetch('/api/state');
					const data = await response.json();
					if (!response.ok)
						throw Object.assign(new Error(data.error || 'Could not load your kitchen.'), {
							status: response.status
						});
					return {
						state: data.state || createNewUserState(),
						etag: response.headers.get('etag') || '',
						userId: data.userId,
						householdId: data.householdId
					};
				},
				put: async (state, etag) => {
					const response = await fetch('/api/state', {
						method: 'PUT',
						headers: {
							'Content-Type': 'application/json',
							...(etag ? { 'If-Match': etag } : { 'If-None-Match': '*' })
						},
						body: JSON.stringify({
							state,
							expectedUserId: owner.id,
							expectedHouseholdId: owner.householdId
						})
					});
					const data = await response.json();
					if (!response.ok)
						throw Object.assign(new Error(data.error || 'Could not sync your kitchen.'), {
							status: response.status
						});
					return { state: data.state, etag: response.headers.get('etag') || '' };
				}
			})
		});
		if (managedAuth) {
			localStorage.removeItem('flavorithm-last-account');
			clearGuestData(localStorage);
			quarantineLegacyKitchen(localStorage);
			kitchen = createInitialState();
			hasSampleRecords = true;
			showStarter = false;
		} else {
			const started = localStorage.getItem('flavorithm-started') === 'yes';
			try {
				// The legacy key could contain a signed-in household. Preserve it separately without loading it.
				quarantineLegacyKitchen(localStorage);
				const local = localStorage.getItem('flavorithm-guest-kitchen');
				if (local) {
					const sanitized = sanitizeKitchenState(JSON.parse(local));
					const loaded = started ? sanitized : backfillSampleData(sanitized);
					if (!themes.includes(loaded.preferences.theme)) loaded.preferences.theme = 'nosh';
					kitchen = loaded;
					hasSampleRecords = hasSampleData(loaded);
				}
			} catch {}
			showStarter = !started;
			kitchenLoaded = true;
		}
		ready = true;
		const pageUrl = new URL(window.location.href);
		const returnFromChatGPT = pageUrl.searchParams.has('chatgpt');
		const reset = pageUrl.searchParams.get('reset');
		const verificationToken = pageUrl.searchParams.get('verify');
		if (returnFromChatGPT) {
			modal = 'settings';
		}
		if (reset && !managedAuth) {
			resetToken = reset;
			modal = 'reset';
		}
		if (returnFromChatGPT || reset || verificationToken) {
			pageUrl.searchParams.delete('chatgpt');
			pageUrl.searchParams.delete('reset');
			pageUrl.searchParams.delete('verify');
			window.history.replaceState({}, '', `${pageUrl.pathname}${pageUrl.search}${pageUrl.hash}`);
		}
		request('/api/auth')
			.then(async (data) => {
				updateAuthMetadata(data);
				if (managedAuth) {
					localStorage.removeItem('flavorithm-last-account');
					clearGuestData(localStorage);
					quarantineLegacyKitchen(localStorage);
					kitchen = createInitialState();
					hasSampleRecords = true;
					kitchenLoaded = false;
					showStarter = false;
				}
				capabilities = {
					emailDelivery: Boolean(data.capabilities?.emailDelivery),
					recipeSearch: Boolean(data.capabilities?.recipeSearch)
				};
				syncing = true;
				const nextUser: User | null = data.user ?? null;
				if (!nextUser) {
					user = null;
					kitchenSync?.clearContext();
					localStorage.removeItem('flavorithm-last-account');
					if (managedAuth) {
						clearManagedIdentity();
						renewManagedSession({ status: 401 });
					}
					syncing = false;
				} else {
					clearHouseholdViewState();
					kitchen = createNewUserState();
					user = nextUser;
					showStarter = false;
					kitchenSync?.prepare(nextUser);
					kitchenLoaded = true;
					saveLastAccount(nextUser);
					const owner = nextUser.id;
					const attempt = connectionAttempt;
					try {
						await runSignedInHydration({
							returnFromChatGPT,
							fetchState: () => request('/api/state'),
							fetchConnections: () => request('/api/connections/chatgpt'),
							adoptState: (saved) => {
								adoptKitchen(saved.state || createNewUserState());
								kitchenLoaded = true;
								showStarter = false;
								syncing = false;
							},
							openSettings: async () => {
								if (online && kitchenSync?.snapshot()) await retrySync();
								await openSettings();
							},
							onConnections: (result) => {
								if (attempt !== connectionAttempt || user?.id !== owner) return;
								chatGPT = result;
								reconcileChatGPTPreferences(kitchen.preferences, chatGPT);
							},
							onConnectionsError: () => {
								if (attempt !== connectionAttempt || user?.id !== owner) return;
								notify('Your ChatGPT connection could not be checked. Open Settings to reconnect.');
							}
						});
						if (!returnFromChatGPT && online && kitchenSync?.snapshot()) {
							await retrySync();
						}
					} catch (stateError) {
						syncing = false;
						kitchenSync?.failLoad((stateError as Error).message);
						if (managedAuth) renewManagedSession(stateError);
						notify(
							'Could not load your kitchen. New edits will stay on this device until sync succeeds.'
						);
					}
				}
				if (verificationToken && !managedAuth) {
					try {
						const verified = await request('/api/auth', {
							action: 'verifyEmail',
							token: verificationToken
						});
						const refreshed = await refreshAuth();
						notify(
							refreshed.user?.id === verified.user?.id && refreshed.user?.emailVerified
								? 'Your email is verified.'
								: 'Email verified. Sign in to access that account.'
						);
					} catch {
						notify('That verification link is invalid or expired. Sign in and request a new one.');
					}
				}
			})
			.catch((error) => {
				if (managedAuth) {
					clearManagedIdentity();
					renewManagedSession(error);
				} else {
					try {
						const cached = JSON.parse(localStorage.getItem('flavorithm-last-account') || 'null');
						if (cached?.id && cached?.householdId) {
							clearHouseholdViewState();
							kitchen = createNewUserState();
							user = cached;
							showStarter = false;
							kitchenLoaded = true;
							kitchenSync?.restore(cached);
							if (online) kitchenSync?.failLoad((error as Error).message);
						}
					} catch {}
				}
				syncing = false;
				notify(
					managedAuth
						? 'Your organization session could not be confirmed. Reconnect to continue.'
						: 'Working locally. Pending edits will retry when you reconnect.'
				);
			})
			.finally(() => {
				guestPersistenceReady = true;
			});
		if ('serviceWorker' in navigator)
			navigator.serviceWorker.register('/service-worker.js').catch(() => {
				/* Offline installation is retried on the next visit. */
			});
		const install = (e: Event) => {
			e.preventDefault();
			deferredInstall = e;
		};
		const connectionChanged = () => {
			online = navigator.onLine;
			if (online) void reconnectKitchen();
			else if (managedAuth) clearManagedIdentity();
		};
		const mobileMedia =
			typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 650px)') : null;
		const syncMobileViewport = () => {
			mobileViewport = Boolean(mobileMedia?.matches);
			if (!mobileMedia?.matches && mobileNav) mobileNav = false;
		};
		syncMobileViewport();
		mobileMedia?.addEventListener('change', syncMobileViewport);
		const calendarMedia =
			typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 650px)') : null;
		const calendarMediaChanged = () => {
			mobileCalendar = Boolean(calendarMedia?.matches);
		};
		calendarMediaChanged();
		calendarMedia?.addEventListener('change', calendarMediaChanged);
		window.addEventListener('online', connectionChanged);
		window.addEventListener('offline', connectionChanged);
		window.addEventListener('beforeinstallprompt', install);
		return () => {
			mobileMedia?.removeEventListener('change', syncMobileViewport);
			calendarMedia?.removeEventListener('change', calendarMediaChanged);
			window.removeEventListener('beforeinstallprompt', install);
			window.removeEventListener('online', connectionChanged);
			window.removeEventListener('offline', connectionChanged);
			clearTimeout(saveTimer);
			connectionPoll?.stop();
			connectionPopup?.close();
			cancelScan(true);
			voiceCapture?.cancel();
		};
	});
	function adoptKitchen(state: AppState) {
		const sanitized = sanitizeKitchenState(state);
		hasSampleRecords = hasSampleData(sanitized);
		if (user && kitchenSync) {
			const snapshotUser = $state.snapshot(user);
			kitchenSync.initialize(snapshotUser, sanitized, stateEtag || '');
			saveLastAccount(snapshotUser);
		} else kitchen = sanitized;
	}
	async function retrySync(prefer?: 'local' | 'remote', expectedEtag?: string | null) {
		if (!online || !user || !kitchenSync) return;
		try {
			await kitchenSync.sync(prefer, prefer ? (expectedEtag ?? reviewedEtag) : undefined);
		} catch (e) {
			syncErrors = (e as Error).message;
			if (managedAuth) {
				clearManagedIdentity();
				renewManagedSession(e);
			}
		}
	}
	async function reconnectKitchen() {
		try {
			await runReconnectWorkflow({
				hadPreviousUser: Boolean(user),
				refreshAuth,
				getCurrentUser: () => user,
				onSignedOut: () => {
					kitchenSync?.clearContext();
					if (managedAuth) {
						clearManagedIdentity();
						renewManagedSession({ status: 401 });
					} else notify('Sign in again to sync the edits saved on this device.');
				},
				restoreContext: (currentUser) => {
					kitchenSync?.restore(currentUser);
				},
				hasPendingEdits: () => Boolean(kitchenSync?.snapshot()),
				fetchState: () => request('/api/state'),
				adoptState: (latest) => {
					adoptKitchen(latest.state || createNewUserState());
					kitchenLoaded = true;
					showStarter = false;
				},
				retrySync: () => retrySync()
			});
		} catch (e) {
			kitchenSync?.failLoad((e as Error).message);
			syncErrors = (e as Error).message;
			if (managedAuth) {
				clearManagedIdentity();
				renewManagedSession(e);
			}
		}
	}
	function exportPendingChanges() {
		void exportKitchen();
	}
	async function flushKitchen() {
		commitInlineEdits();
		clearTimeout(saveTimer);
		await writeChain;
		if (user && kitchenSync) {
			kitchenSync.stage(sanitizeKitchenState(JSON.parse(JSON.stringify(kitchen))));
			await kitchenSync.sync();
			if (kitchenSync.snapshot())
				throw new Error(
					'Sync or back up your pending kitchen changes before switching accounts or households.'
				);
		}
	}

	function freshKitchen() {
		clearEditingShoppingState();
		if (!hasSampleData(kitchen)) {
			hasSampleRecords = false;
			showStarter = false;
			if (!user && !managedAuth) localStorage.setItem('flavorithm-started', 'yes');
			return;
		}
		const previousKitchen = sanitizeKitchenState(JSON.parse(JSON.stringify(kitchen)));
		const wasShowingStarter = showStarter;
		const previousStarted =
			!user && !managedAuth ? localStorage.getItem('flavorithm-started') : null;
		kitchen = clearSampleData(previousKitchen);
		hasSampleRecords = hasSampleData(kitchen);
		pantryDraft = null;
		resetPantryFilters();
		const appliedSnapshot = JSON.stringify(kitchen);
		showStarter = false;
		if (!user && !managedAuth) localStorage.setItem('flavorithm-started', 'yes');
		if (modal === 'settings') closeDialog();
		notify('Sample data cleared.', () => {
			if (JSON.stringify(kitchen) === appliedSnapshot) {
				pantryDraft = null;
				clearEditingShoppingState();
				kitchen = previousKitchen;
				hasSampleRecords = hasSampleData(previousKitchen);
				if (wasShowingStarter && !user && !managedAuth) {
					showStarter = true;
					if (previousStarted === null) localStorage.removeItem('flavorithm-started');
					else localStorage.setItem('flavorithm-started', previousStarted);
				}
				notify('Sample data restored.');
			} else {
				notify('Your kitchen changed again. Review the current values before editing.');
			}
		});
	}
	function navigate(id: string) {
		commitInlineEdits();
		page = id;
		mobileNav = false;
	}
	function addIngredients() {
		if (voiceBusy || busy) return;
		const boundedInput = pantryInput.slice(0, 20_000);
		const segments = boundedInput
			.split(/[,;\r\n]+(?![^\[\]]*\])/)
			.map((value) => value.trim())
			.filter(Boolean);
		const parsed = parseIngredientLines(boundedInput);
		const rejectedInput = Math.max(0, segments.length - parsed.length);
		commitInlineEdits();
		const previousPantry = JSON.parse(JSON.stringify(kitchen.pantry)) as AppState['pantry'];
		const previousShopping = JSON.parse(JSON.stringify(kitchen.shopping)) as AppState['shopping'];
		const existingKeys = new Set(
			kitchen.pantry
				.filter((item) => !item.sample && !item.expires?.trim())
				.map(
					(item) => `${normalizeIngredientName(item.name)}\u0000${unitInfo(item.unit).dimension}`
				)
		);
		let lotCount = kitchen.pantry.length;
		let skippedCapacity = 0;
		const additions: AppState['shopping'] = [];
		for (const item of parsed) {
			const name = item.name.trim().slice(0, 200);
			const unit = item.unit.trim().slice(0, 40) || 'each';
			const key = `${normalizeIngredientName(name)}\u0000${unitInfo(unit).dimension}`;
			if (!existingKeys.has(key)) {
				if (lotCount >= 1_000) {
					skippedCapacity += 1;
					continue;
				}
				existingKeys.add(key);
				lotCount += 1;
			}
			additions.push({
				id: crypto.randomUUID(),
				name,
				quantity: Math.min(1_000_000, item.quantity),
				unit,
				category: item.category.slice(0, 100),
				checked: true
			});
		}
		if (!additions.length) {
			notify(
				skippedCapacity > 0 && rejectedInput === 0
					? 'Your pantry can hold up to 1,000 ingredients.'
					: 'Enter at least one valid ingredient.'
			);
			return;
		}
		const updated = addPantryItems(kitchen, additions);
		kitchen.pantry = updated.pantry;
		kitchen.shopping = updated.shopping;
		if (editingShoppingId && !kitchen.shopping.some((entry) => entry.id === editingShoppingId))
			clearEditingShoppingState();
		const appliedPantry = JSON.stringify(kitchen.pantry);
		const appliedShopping = JSON.stringify(kitchen.shopping);
		pantryInput = '';
		modal = '';
		const acceptedCount = additions.length;
		const suffix =
			skippedCapacity > 0
				? ' (1,000-ingredient limit reached)'
				: rejectedInput > 0
					? ` (${rejectedInput} invalid ${rejectedInput === 1 ? 'entry' : 'entries'} skipped)`
					: '';
		notify(
			`${acceptedCount} ingredient${acceptedCount === 1 ? '' : 's'} added to your pantry${suffix}.`,
			() => {
				if (
					JSON.stringify(kitchen.pantry) === appliedPantry &&
					JSON.stringify(kitchen.shopping) === appliedShopping
				) {
					kitchen.pantry = previousPantry;
					kitchen.shopping = previousShopping;
					if (
						editingShoppingId &&
						!kitchen.shopping.some((entry) => entry.id === editingShoppingId)
					)
						clearEditingShoppingState();
				} else notify('Your pantry changed again. Review the current quantities before editing.');
			}
		);
	}

	async function authenticate(event: SubmitEvent) {
		event.preventDefault();
		if (managedAuth) {
			openAuthentication();
			return;
		}
		busy = true;
		error = '';
		try {
			syncing = true;
			commitInlineEdits();
			clearTimeout(saveTimer);
			const isRegister = authMode === 'register';
			const guestKitchen = isRegister
				? clearSampleData(sanitizeKitchenState(JSON.parse(JSON.stringify(kitchen))))
				: null;
			const result = await request('/api/auth', { action: authMode, name, email, password });
			const authenticatedUser: User = result.user;
			password = '';
			showStarter = false;
			clearHouseholdViewState();
			stateEtag = null;
			kitchen = guestKitchen ?? createNewUserState();
			hasSampleRecords = hasSampleData(kitchen);
			user = authenticatedUser;
			kitchenSync?.prepare(authenticatedUser);
			kitchenLoaded = true;
			saveLastAccount(authenticatedUser);
			if (guestKitchen) {
				kitchen = guestKitchen;
				hasSampleRecords = hasSampleData(guestKitchen);
				kitchenSync?.stage(guestKitchen);
				if (!syncErrors) {
					clearGuestKitchen(localStorage);
					clearGuestData(localStorage);
				}
			}
			let stateLoaded = false;
			try {
				const saved = await request('/api/state');
				if (guestKitchen) {
					adoptKitchen(saved.state || createNewUserState());
					if (!saved.state && !kitchenSync?.snapshot()) {
						const created = await request('/api/state', { state: guestKitchen }, 'PUT');
						adoptKitchen(created.state || guestKitchen);
					} else {
						await kitchenSync?.sync();
					}
				} else if (saved.state) {
					adoptKitchen(saved.state);
					if (online && kitchenSync?.snapshot()) await retrySync();
				} else {
					const initial = createNewUserState();
					const created = await request('/api/state', { state: initial }, 'PUT');
					adoptKitchen(created.state || initial);
					if (online && kitchenSync?.snapshot()) await retrySync();
				}
				stateLoaded = true;
			} catch (stateError) {
				kitchenSync?.failLoad((stateError as Error).message);
			}
			syncing = false;
			if (stateLoaded) {
				await refreshConnections().catch(() =>
					notify('Your ChatGPT connection could not be checked. Open Settings to reconnect.')
				);
			}
			if (resumeDialog) {
				const target = resumeDialog;
				resumeDialog = '';
				modal = target;
			} else {
				modal = '';
				if (isRegister && stateLoaded && !kitchen.preferences.onboardingStatus) openOnboarding();
			}
			const syncedCleanly =
				stateLoaded && !(guestKitchen && (syncErrors || kitchenSync?.snapshot()));
			const firstName = authenticatedUser.name.split(' ')[0] || 'chef';
			notify(
				syncedCleanly
					? `Welcome to your kitchen, ${firstName}.`
					: 'Account ready. Kitchen sync failed—your items are saved on this device.'
			);
		} catch (e) {
			error = (e as Error).message;
		} finally {
			busy = false;
			syncing = false;
		}
	}
	async function logout() {
		cancelScan(true);
		if (managedAuth) {
			if (!providerLogoutUrl) return;
			try {
				await flushKitchen();
			} catch {
				notify('Signing out. The latest edits may still be syncing.');
			}
			clearManagedIdentity();
			window.location.assign(providerLogoutUrl);
			return;
		}
		try {
			syncing = true;
			clearTimeout(saveTimer);
			await flushKitchen();
			await request('/api/auth', { action: 'logout' });
			kitchenSync?.clearContext();
			clearHouseholdViewState();
			localStorage.removeItem('flavorithm-last-account');
			user = null;
			editingRecipe = null;
			editingRecipeMode = 'edit';
			inviteCode = '';
			currentInviteId = '';
			joinCode = '';
			members = [];
			householdInvites = [];
			canManageHousehold = false;
			clearVoiceSession();
			pantryInput = '';
			importSession = emptyImportSession();
			resumeDialog = '';
			pantryDraft = null;
			resetPantryFilters();
			kitchen = createInitialState();
			hasSampleRecords = true;
			cookedHistoryLimit = COOKED_HISTORY_PAGE_SIZE;
			clearGuestData(localStorage);
			quarantineLegacyKitchen(localStorage);
			clearAIConnectionState();
			stateEtag = null;
			syncing = false;
			modal = '';
			notify('Signed out. Your household is safely saved.');
		} catch (e) {
			notify((e as Error).message);
		}
	}

	function clearAIConnectionState() {
		connectionAttempt++;
		connectionActive = false;
		apiKey = '';
		providers = [];
		accountModels = [];
		catalogVersion++;
		catalogLoading = false;
		catalogError = '';
		connectionPoll?.stop();
		connectionPoll = undefined;
		connectionPopup?.close();
		connectionPopup = null;
		connectionBusy = false;
		chatGPTAuthorizationUrl = '';
		chatGPTDevice = null;
		chatGPT = { configured: false, mode: 'unavailable', accounts: [] };
	}
	async function loadModelCatalog(connectionsTask?: Promise<void>) {
		if (!user) return;
		const version = ++catalogVersion;
		const owner = user.id;
		catalogLoading = true;
		catalogError = '';
		await runConcurrentModelCatalog({
			connectionsTask,
			isCurrent: () => version === catalogVersion && user?.id === owner,
			getEntitledAccountId: () =>
				entitledChatGPTAccountId(kitchen.preferences, chatGPT.accounts, chatGPT.host),
			fetchPublicCatalog: () => request('/api/models'),
			fetchAccountCatalog: (accountId) =>
				request(`/api/models?connection=chatgpt&accountId=${encodeURIComponent(accountId)}`),
			onResult: ({ catalog, account }) => {
				if (catalog.status === 'fulfilled') providers = catalog.value.providers;
				else
					catalogError =
						(catalog.reason as Error)?.message || 'The provider catalog could not be loaded.';
				if (account.status === 'fulfilled')
					accountModels = account.value?.providers[0]?.models || [];
				else {
					accountModels = [];
					catalogError =
						(account.reason as Error)?.message || 'ChatGPT models could not be loaded.';
				}
				catalogLoading = false;
			}
		});
	}
	async function refreshConnections() {
		if (!user) return;
		const owner = user.id;
		const attempt = connectionAttempt;
		const result = await request('/api/connections/chatgpt');
		if (attempt !== connectionAttempt || user?.id !== owner) return;
		chatGPT = result;
		reconcileChatGPTPreferences(kitchen.preferences, chatGPT);
	}
	async function refreshAISettings() {
		error = '';
		try {
			await loadModelCatalog(refreshConnections());
		} catch (e) {
			error = (e as Error).message;
		}
	}
	async function openSettings(focusTarget: boolean | 'ai' | 'voice' = false) {
		mobileNav = false;
		if (!focusTarget && modal !== 'pantry' && modal !== 'import' && modal !== 'settings') {
			resumeDialog = '';
		}
		modal = 'settings';
		error = '';
		const headingId =
			focusTarget === true || focusTarget === 'ai'
				? 'ai-connection-heading'
				: focusTarget === 'voice'
					? 'voice-settings-heading'
					: '';
		await runOpenSettingsWorkflow({
			initialUserId: user?.id ?? null,
			getCurrentUserId: () => user?.id ?? null,
			refreshAuth,
			loadConnectionsAndCatalog: () => loadModelCatalog(refreshConnections()),
			onReadyToFocus: headingId
				? async () => {
						if (modal !== 'settings') return;
						await tick();
						document.getElementById(headingId)?.focus();
					}
				: undefined,
			onAuthError: (e) => {
				if (online || syncErrors) error = (e as Error).message;
			},
			onError: (e) => {
				error ||= (e as Error).message;
			}
		});
	}
	async function changeConnection(providerId?: string) {
		if (providerId === kitchen.preferences.provider) return;
		const currentDevice = chatGPTDevice;
		connectionAttempt++;
		connectionActive = false;
		if (providerId && providerId !== kitchen.preferences.provider) {
			apiKey = '';
			kitchen.preferences.provider = providerId;
		}
		connectionPoll?.stop();
		connectionPoll = undefined;
		connectionPopup?.close();
		connectionPopup = null;
		connectionBusy = false;
		chatGPTAuthorizationUrl = '';
		chatGPTDevice = null;
		if (currentDevice && user) {
			void request('/api/connections/chatgpt', {
				action: 'cancel',
				loginId: currentDevice.loginId
			}).catch(() => {});
		}
		kitchen.preferences.model = '';
		kitchen.preferences.reasoning = undefined;
		accountModels = [];
		error = '';
		try {
			await loadModelCatalog(refreshConnections());
		} catch (e) {
			error = (e as Error).message;
		}
	}
	async function connectChatGPT(accountId?: string, reconsent = false) {
		if (!user) {
			openAuthentication();
			return;
		}
		const currentDevice = chatGPTDevice;
		const attempt = ++connectionAttempt;
		const owner = user.id;
		connectionPoll?.stop();
		connectionPoll = undefined;
		connectionPopup?.close();
		connectionPopup = null;
		if (currentDevice) {
			void request('/api/connections/chatgpt', {
				action: 'cancel',
				loginId: currentDevice.loginId
			}).catch(() => {});
		}
		connectionActive = true;
		connectionBusy = true;
		chatGPTAuthorizationUrl = '';
		chatGPTDevice = null;
		error = '';
		const popup =
			chatGPT.mode === 'device'
				? null
				: window.open('about:blank', 'flavorithm-chatgpt-connect', 'popup,width=620,height=780');
		connectionPopup = popup;
		const isCurrentInSettings = () =>
			attempt === connectionAttempt && user?.id === owner && modal === 'settings';
		try {
			const previousAccounts = new Map(chatGPT.accounts.map((a) => [a.id, a.updatedAt]));
			const previous = JSON.stringify(chatGPT.accounts);
			const result = await request('/api/connections/chatgpt', {
				action: 'start',
				accountId,
				reconsent
			});
			if (!isCurrentInSettings()) {
				popup?.close();
				if (connectionPopup === popup) connectionPopup = null;
				if (result?.kind === 'device' && user?.id === owner) {
					void request('/api/connections/chatgpt', {
						action: 'cancel',
						loginId: result.loginId
					}).catch(() => {});
				}
				return;
			}
			if (result.kind === 'device') {
				chatGPTDevice = result;
				connectionPoll = startConnectionPoll({
					intervalMs: result.interval * 1000,
					expiresAt: result.expiresAt,
					attempt,
					getAttempt: () => connectionAttempt,
					owner,
					getOwner: () => user?.id,
					isOpen: () => modal === 'settings',
					poll: async ({ expired, stop }) => {
						try {
							const connected = await request('/api/connections/chatgpt', {
								action: 'poll',
								loginId: result.loginId
							});
							if (!isCurrentInSettings()) {
								stop();
								return false;
							}
							if (connected.connected) {
								stop();
								connectionActive = false;
								connectionBusy = false;
								chatGPTDevice = null;
								await refreshConnections();
								if (attempt !== connectionAttempt || user?.id !== owner) return false;
								kitchen.preferences.chatgptAccountId = connected.accountId;
								kitchen.preferences.provider = 'chatgpt';
								kitchen.preferences.model = '';
								kitchen.preferences.reasoning = undefined;
								await loadModelCatalog();
								notify('ChatGPT connected. Choose a model.');
								return false;
							}
							if (expired) {
								stop();
								connectionActive = false;
								connectionBusy = false;
								chatGPTDevice = null;
								error = 'ChatGPT authorization expired. Start again.';
								return false;
							}
						} catch (e) {
							if (!isCurrentInSettings()) {
								stop();
								return false;
							}
							const status = (e as { status?: number }).status;
							// Keep the original login alive through brief deployment/network outages.
							if (
								chatGPTDevice &&
								!expired &&
								Date.now() < result.expiresAt &&
								(status === undefined || status === 429 || status >= 500)
							)
								return;
							stop();
							connectionActive = false;
							connectionBusy = false;
							chatGPTDevice = null;
							error = (e as Error).message;
							return false;
						}
					}
				});
				return;
			}

			chatGPTAuthorizationUrl = result.authorizationUrl;
			if (connectionPopup) connectionPopup.location.href = result.authorizationUrl;
			else if (
				importSession.url ||
				importSession.text ||
				importSession.photo ||
				importSession.draft
			) {
				chatGPTAuthorizationUrl = result.authorizationUrl;
			} else {
				connectionActive = false;
				window.location.assign(result.authorizationUrl);
				return;
			}
			const expiresAt =
				typeof result.expiresAt === 'number' ? result.expiresAt : Date.now() + CHATGPT_OAUTH_TTL_MS;
			connectionPoll = startConnectionPoll({
				intervalMs: CHATGPT_OAUTH_POLL_INTERVAL_MS,
				expiresAt,
				attempt,
				getAttempt: () => connectionAttempt,
				owner,
				getOwner: () => user?.id,
				isOpen: () => modal === 'settings',
				poll: async ({ expired, stop }) => {
					try {
						await refreshConnections();
						if (!isCurrentInSettings()) {
							stop();
							return false;
						}
						const connectionChanged = JSON.stringify(chatGPT.accounts) !== previous;
						if (connectionChanged || connectionPopup?.closed) {
							stop();
							connectionActive = false;
							connectionBusy = false;
							chatGPTAuthorizationUrl = '';
							chatGPTDevice = null;
							const account = chatGPT.accounts.find(
								(a) =>
									a.id !== HOST_CONNECTION_ID &&
									a.connected &&
									(accountId
										? a.id === accountId
										: !previousAccounts.has(a.id) || previousAccounts.get(a.id) !== a.updatedAt)
							);
							if (account && connectionChanged) {
								connectionPopup?.close();
								connectionPopup = null;
								kitchen.preferences.chatgptAccountId = account.id;
								kitchen.preferences.provider = 'chatgpt';
								kitchen.preferences.model = '';
								kitchen.preferences.reasoning = undefined;
								await loadModelCatalog();
								notify(
									account.planEnabled
										? 'ChatGPT connected. Choose a model to cook with your plan.'
										: 'ChatGPT signed in. Enable plan usage to generate recipes.'
								);
							} else if (!connectionChanged) {
								connectionPopup = null;
								notify('The authorization window closed. Your previous connection is unchanged.');
							}
							return false;
						}
						if (expired) {
							stop();
							connectionPopup?.close();
							connectionPopup = null;
							connectionActive = false;
							connectionBusy = false;
							chatGPTAuthorizationUrl = '';
							chatGPTDevice = null;
							error = 'The connection window timed out. Try connecting again.';
							return false;
						}
					} catch (e) {
						stop();
						if (!isCurrentInSettings()) return false;
						connectionPopup?.close();
						connectionPopup = null;
						connectionActive = false;
						connectionBusy = false;
						chatGPTAuthorizationUrl = '';
						chatGPTDevice = null;
						error = (e as Error).message;
						return false;
					}
				}
			});
		} catch (e) {
			popup?.close();
			if (connectionPopup === popup) connectionPopup = null;
			if (!isCurrentInSettings()) return;
			connectionActive = false;
			connectionBusy = false;
			chatGPTAuthorizationUrl = '';
			chatGPTDevice = null;
			error = (e as Error).message;
		}
	}
	async function cancelChatGPTDevice() {
		const current = chatGPTDevice;
		connectionAttempt++;
		connectionActive = false;
		connectionPoll?.stop();
		connectionPoll = undefined;
		connectionPopup?.close();
		connectionPopup = null;
		connectionBusy = false;
		chatGPTAuthorizationUrl = '';
		chatGPTDevice = null;
		if (current && user) {
			try {
				await request('/api/connections/chatgpt', { action: 'cancel', loginId: current.loginId });
			} catch {
				/* Session expiry also prevents pending authorization from saving credentials. */
			}
		}
	}
	async function copyChatGPTDeviceCode() {
		if (!chatGPTDevice) return;
		try {
			await navigator.clipboard.writeText(chatGPTDevice.userCode);
			notify('Code copied.');
		} catch {
			notify('Select the code and copy it manually.');
		}
	}

	async function disconnectChatGPT() {
		if (!activeChatGPTAccount) return;
		connectionBusy = true;
		error = '';
		try {
			const result = await request('/api/connections/chatgpt', {
				action: 'disconnect',
				accountId: activeChatGPTAccount.id
			});
			await refreshConnections();
			accountModels = [];
			kitchen.preferences.reasoning = undefined;
			kitchen.preferences.model = '';
			notify(
				result.remoteRevoked
					? 'ChatGPT disconnected.'
					: 'Disconnected locally. Remote revocation was not confirmed; review access in ChatGPT Settings.'
			);
		} catch (e) {
			error = (e as Error).message;
		} finally {
			connectionBusy = false;
			chatGPTAuthorizationUrl = '';
			chatGPTDevice = null;
		}
	}
	function hasPersonalAIReady() {
		const isPlan = kitchen.preferences.provider === 'chatgpt';
		return (
			(isPlan
				? Boolean(activeChatGPTAccount?.connected && activeChatGPTAccount.planEnabled)
				: Boolean(apiKey)) && Boolean(kitchen.preferences.model)
		);
	}
	function hasAIConnection() {
		return Boolean(user) && hasPersonalAIReady();
	}
	async function needAI() {
		if (!user) {
			openAuthentication();
			notify(
				managedAuth
					? 'Sign in through your organization to use your AI connection.'
					: 'Create an account to use your AI connection.'
			);
			return false;
		}
		if (usingHostAI) return true;
		if (!kitchen.preferences.usePersonalAI && !hasPersonalAIReady()) {
			await refreshConnections().catch(() => {});
			if (usingHostAI) return true;
		}
		const isPlan = kitchen.preferences.provider === 'chatgpt';
		if (!hasPersonalAIReady()) {
			void openSettings(true);
			notify(
				isPlan
					? 'Connect your ChatGPT plan and choose an available model.'
					: 'Connect a model in Settings to generate recipes.'
			);
			return false;
		}
		return true;
	}
	async function ai(action: string, extra: Record<string, unknown> = {}, signal?: AbortSignal) {
		const isSearch = action === 'search';
		const useHost = !isSearch && Boolean(chatGPT.host && !kitchen.preferences.usePersonalAI);
		const buildPayload = (hostMode: boolean) => ({
			action,
			...(isSearch
				? {}
				: hostMode && chatGPT.host
					? {
							usePersonalAI: false,
							provider: 'chatgpt',
							model: chatGPT.host.model,
							connectionId: HOST_CONNECTION_ID
						}
					: {
							usePersonalAI: true,
							...(kitchen.preferences.provider === 'chatgpt'
								? { connectionId: kitchen.preferences.chatgptAccountId }
								: { apiKey }),
							provider: kitchen.preferences.provider,
							model: kitchen.preferences.model,
							reasoning: kitchen.preferences.reasoning
						}),
			...(action === 'capture' || action === 'chat' || isSearch
				? {}
				: {
						pantry: kitchen.pantry.filter(
							(item) => item.quantity > 0 && expiryStatus(item.expires) !== 'expired'
						),
						preferences: kitchen.preferences,
						recipes: kitchen.recipes.filter((r) => r.rating).slice(0, 30),
						prompt
					}),
			...extra
		});
		try {
			return await request('/api/ai', buildPayload(useHost), 'POST', signal);
		} catch (err) {
			if (useHost && (err as { status?: number })?.status === 400) {
				await refreshConnections().catch(() => {});
				if (!chatGPT.host) {
					if (hasPersonalAIReady()) {
						return await request('/api/ai', buildPayload(false), 'POST', signal);
					}
					void openSettings(true);
				}
			}
			throw err;
		}
	}
	let butlerChat = $state<ButlerChat>();
	let butlerOpen = $state(false);
	let voiceOverlay = $derived(
		Boolean(butlerOpen || editingRecipe || (!modal && (selected || mobileNav)))
	);
	$effect(() => {
		if (!voiceTarget) return;
		if (
			voiceBusy &&
			!isVoiceTargetActive(voiceTarget, {
				modal,
				page,
				overlay: voiceOverlay,
				reviewingDraft: isReviewingImportDraft(importSession)
			})
		) {
			clearVoiceSession();
		} else if (voiceTarget === 'shopping' && page !== 'shopping') {
			clearVoiceSession();
		}
	});
	let cookingSteps = $state<Record<string, number[]>>({});
	let selectedMealServings = $state<number | undefined>();
	let cookingSessionKey = $derived(
		`${user?.id ?? 'guest'}:${user?.householdId ?? ''}:${selected?.id ?? ''}`
	);
	$effect(() => {
		if (selected && !cookingSteps[cookingSessionKey]) cookingSteps[cookingSessionKey] = [];
	});
	async function askButler(
		message: string,
		history: { role: 'user' | 'assistant'; content: string }[],
		signal?: AbortSignal,
		recipeDrafts: Recipe[] = []
	) {
		if (!(await needAI())) {
			butlerChat?.close();
			throw new Error('Sign in and connect a model in Settings to speak with Basil.');
		}
		const owner = `${user?.id}:${user?.householdId}`;
		const snapshot = JSON.stringify(kitchen);
		const { diet, allergies, maxTime, complexity, cuisines, theme, dark } = kitchen.preferences;
		const context = JSON.stringify({
			...JSON.parse(snapshot),
			preferences: { diet, allergies, maxTime, complexity, cuisines, theme, dark },
			today: dateKey(new Date()),
			availableThemes: themes,
			recipeDrafts,
			selectedRecipeId:
				selected?.id ?? (editingRecipeMode === 'edit' ? editingRecipe?.id : undefined),
			userName: user?.name?.trim().slice(0, 80),
			page
		});
		const result = await ai(
			'chat',
			{
				prompt: message,
				messages: [
					...pairButlerHistory(
						history,
						(turn) => turn.content.slice(0, 8000),
						BUTLER_HISTORY_LIMIT
					),
					{ role: 'user', content: message }
				],
				context
			},
			signal
		);
		if (owner !== `${user?.id}:${user?.householdId}`)
			throw new Error('The active kitchen changed. Ask Basil again.');
		return result as ButlerChatResult;
	}
	function applyButler(commands: unknown[], expectedSnapshot: string) {
		if (JSON.stringify(kitchen) !== expectedSnapshot) {
			throw new Error(
				'Your kitchen changed since this proposal. Ask Basil for an updated proposal.'
			);
		}
		const previousKitchen = JSON.parse(JSON.stringify(kitchen)) as AppState;
		const result = applyButlerCommands(JSON.parse(JSON.stringify(kitchen)), commands);
		kitchen = result.state;
		hasSampleRecords = hasSampleData(kitchen);
		for (const effect of result.effects) {
			if (effect.type === 'navigate') navigate(effect.page);
			else if (effect.type === 'recipe.open') {
				butlerChat?.close();
				const recipe = kitchen.recipes.find((recipe) => recipe.id === effect.id);
				if (recipe && effect.mode === 'edit') editSavedRecipe(recipe);
				else if (recipe && effect.mode === 'cook') {
					const meal = kitchen.meals.find(
						(item) => item.recipeId === recipe.id && !item.completedAt
					);
					if (meal) openCookDialog(meal);
					else selected = recipe;
				} else selected = recipe ?? null;
			} else if (effect.type === 'ui') {
				butlerChat?.close();
				openButlerControl(effect.action);
			}
		}
		const appliedSnapshot = JSON.stringify(kitchen);
		notify('Basil’s changes applied.', () => {
			if (JSON.stringify(kitchen) === appliedSnapshot) {
				kitchen = previousKitchen;
				hasSampleRecords = hasSampleData(previousKitchen);
			} else notify('Your kitchen changed again. Review the current values before editing.');
		});
		return appliedSnapshot;
	}
	function openButlerControl(target: string) {
		switch (target) {
			case 'settings':
				if (modal === 'pantry' || modal === 'import') resumeDialog = modal;
				void openSettings();
				break;
			case 'voice-settings':
				if (modal === 'pantry' || modal === 'import') resumeDialog = modal;
				void openSettings('voice');
				break;
			case 'ai-settings':
				void openSettings(true);
				break;
			case 'recipe-new':
				openNewRecipe();
				break;
			case 'import':
				openImport();
				break;
			case 'pantry-add':
				modal = 'pantry';
				break;
			case 'onboarding':
				openOnboarding();
				break;
			case 'household':
			case 'invite':
			case 'join-household':
				void household();
				break;
			case 'export-kitchen':
				void exportKitchen();
				break;
			case 'export-shopping':
				void exportList();
				break;
			case 'export-pending':
				exportPendingChanges();
				break;
			case 'sign-in':
				openAuthentication();
				break;
			case 'sign-out':
				void logout();
				break;
			case 'delete-account':
				if (!managedAuth) modal = 'delete';
				else void openSettings();
				break;
			case 'leave-household':
				void openLeaveHousehold();
				break;
			case 'scan':
				if (!scanBusy && !busy && !voiceBusy) imageInput?.click();
				break;
			case 'dictate':
				dictateRecipe();
				break;
			case 'generate':
				modal = 'generate';
				break;
			case 'search':
				if (capabilities.recipeSearch) {
					modal = 'search';
					error = '';
				} else {
					openImport();
				}
				break;
			case 'taste':
				modal = 'taste';
				break;
		}
	}

	async function generate() {
		if (!(await needAI())) return;
		busy = true;
		error = '';
		try {
			const result = await ai('generate');
			kitchen.recipes = insertRecipes(kitchen.recipes, result.recipes);
			modal = '';
			page = 'discover';
			filter = 'For you';
			notify('Recipes generated.');
		} catch (e) {
			error = (e as Error).message;
			notify(error);
		} finally {
			busy = false;
		}
	}
	async function scan(event: Event) {
		const input = (event.currentTarget ?? event.target) as HTMLInputElement | null;
		const file = input?.files?.[0];
		if (input) input.value = '';
		if (imageInput) imageInput.value = '';
		if (!file || scanBusy || busy || voiceBusy || !(await needAI())) return;
		const generation = ++scanGeneration;
		const currentController = new AbortController();
		scanController = currentController;
		const owner = `${user?.id ?? 'guest'}:${user?.householdId ?? ''}`;
		scanBusy = true;
		try {
			const image = await prepareAIPhoto(file, { signal: currentController.signal });
			const result = await ai('vision', { image }, currentController.signal);
			if (
				generation !== scanGeneration ||
				currentController.signal.aborted ||
				owner !== `${user?.id ?? 'guest'}:${user?.householdId ?? ''}`
			)
				return;
			const items = Array.isArray(result?.ingredients) ? result.ingredients : [];
			if (!items.length) {
				notify('No ingredients detected in that photo.');
				return;
			}
			const recognized = items
				.map((i: { name: string; quantity: number; unit: string; category?: string }) => {
					const cleanName = String(i.name ?? '')
						.replace(/[,;\r\n]+/g, ' ')
						.replace(/\s+/g, ' ')
						.trim();
					const cleanCategory = String(i.category ?? '')
						.replace(/[\[\]\r\n]+/g, ' ')
						.replace(/\s+/g, ' ')
						.trim();
					const displayUnit = unitInfo(String(i.unit ?? '')).display;
					return cleanCategory
						? `${i.quantity} ${displayUnit} ${cleanName} [${cleanCategory}]`
						: `${i.quantity} ${displayUnit} ${cleanName}`;
				})
				.join('\n');
			pantryInput = [pantryInput.trim(), recognized].filter(Boolean).join('\n').slice(0, 20000);
			modal = 'pantry';
			notify('Review what we spotted before adding it.');
		} catch (e) {
			if (generation === scanGeneration) {
				notify(
					currentController.signal.aborted
						? 'Photo scan cancelled.'
						: e instanceof Error && e.message
							? e.message
							: 'Could not recognize ingredients from that photo.'
				);
			}
		} finally {
			if (generation === scanGeneration) {
				scanBusy = false;
				scanController = undefined;
			}
			if (input) input.value = '';
			if (imageInput) imageInput.value = '';
		}
	}
	function isFocusManagedByVoice(): boolean {
		if (typeof document === 'undefined') return false;
		const active = document.activeElement;
		return (
			!active ||
			active === document.body ||
			active === voiceReturnFocus ||
			active === shoppingMicButton ||
			Boolean(voiceSessionEl?.contains(active))
		);
	}
	function isInteractiveFocusElement(el: HTMLElement | null | undefined): el is HTMLElement {
		return Boolean(
			el &&
			el.isConnected &&
			!(el as HTMLButtonElement).disabled &&
			!el.closest?.('[inert], [hidden]')
		);
	}
	function scheduleVoiceIdleFocus(endedTarget: VoiceTarget | '', restoreEl: HTMLElement | null) {
		if (!endedTarget) return;
		void tick().then(() => {
			if (
				voiceBusy ||
				voiceRetained ||
				!isVoiceTargetActive(endedTarget, {
					modal,
					page,
					overlay: voiceOverlay,
					reviewingDraft: isReviewingImportDraft(importSession)
				})
			) {
				return;
			}
			if (isInteractiveFocusElement(restoreEl)) {
				restoreEl.focus({ preventScroll: true });
				return;
			}
			if (endedTarget === 'pantry' && isInteractiveFocusElement(pantryVoiceButton)) {
				pantryVoiceButton.focus({ preventScroll: true });
				return;
			}
			if (typeof document !== 'undefined') {
				const activeDialog = document.querySelector<HTMLElement>('[aria-modal="true"]');
				if (activeDialog && !activeDialog.contains(document.activeElement)) {
					const dialogControl = activeDialog.querySelector<HTMLElement>(
						'button:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"])'
					);
					(isInteractiveFocusElement(dialogControl) ? dialogControl : activeDialog).focus({
						preventScroll: true
					});
				}
			}
		});
	}
	function clearVoiceSession(restoreFocus = true) {
		const { endedTarget, restoreEl, shouldRestore } = untrack(() => {
			const target = voiceTarget;
			const el = target === 'shopping' ? (shoppingMicButton ?? voiceReturnFocus) : voiceReturnFocus;
			return {
				endedTarget: target,
				restoreEl: el,
				shouldRestore: restoreFocus && Boolean(target) && isFocusManagedByVoice()
			};
		});
		const current = voiceCapture;
		voiceCapture = undefined;
		current?.cancel();
		voiceStarting = false;
		voiceState = 'idle';
		voiceRetained = false;
		voiceError = '';
		voiceTarget = '';
		voiceReturnFocus = null;
		activeVoiceImportSession = undefined;
		if (shouldRestore) {
			scheduleVoiceIdleFocus(endedTarget, restoreEl);
		}
	}
	function openVoiceSettings() {
		if (modal === 'pantry' || modal === 'import') resumeDialog = modal;
		else if (voiceTarget === 'pantry' || voiceTarget === 'import') resumeDialog = voiceTarget;
		else resumeDialog = '';
		void openSettings('voice');
	}
	function discardVoiceRecording() {
		voiceCapture?.discard();
		clearVoiceSession();
	}
	async function retryVoiceTranscription() {
		if (voiceBusy || !voiceCapture?.hasRetainedAudio || !voiceTarget) return;
		const plan = planVoiceRetry({
			modal,
			voiceTarget,
			provider: voiceProvider,
			localAvailable: localVoiceAvailable,
			signedIn: Boolean(user),
			apiKey: voiceApiKey
		});
		if (plan.action === 'auth') {
			resumeDialog = plan.resumeDialog;
			openAuthentication();
			notify(plan.message);
			return;
		}
		if (plan.action === 'settings') {
			resumeDialog = plan.resumeDialog;
			void openSettings('voice');
			notify(plan.message);
			return;
		}
		if (plan.action === 'error') {
			voiceError = plan.message;
			notify(plan.message);
			return;
		}
		voiceError = '';
		if (voiceTarget === 'import') {
			importSession.reviewingDraft = false;
			activeVoiceImportSession = importSession;
		}
		await voiceCapture.retry({
			provider: plan.provider,
			model: voiceModel,
			apiKey: voiceApiKey
		});
	}
	function dictate() {
		if (voiceBusy) return;
		void startDictation('pantry');
	}
	function dictateRecipe() {
		if (voiceBusy) return;
		void startDictation('import');
	}
	function dictateShopping() {
		if (voiceBusy) return;
		void startDictation('shopping');
	}
	async function startDictation(target: VoiceTarget) {
		if (voiceBusy) return;
		const plan = planVoiceStart({
			target,
			modal,
			provider: voiceProvider,
			localAvailable: localVoiceAvailable,
			signedIn: Boolean(user),
			apiKey: voiceApiKey
		});
		if (plan.action === 'auth') {
			resumeDialog = plan.resumeDialog;
			openAuthentication();
			notify(plan.message);
			return;
		}
		if (plan.action === 'settings') {
			resumeDialog = plan.resumeDialog;
			void openSettings('voice');
			notify(plan.message);
			return;
		}
		const activeEl =
			typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		clearVoiceSession(false);
		resumeDialog = '';
		voiceReturnFocus = target === 'shopping' ? (shoppingMicButton ?? activeEl) : activeEl;
		if (target === 'import') {
			importSession.reviewingDraft = false;
			if (modal !== 'import') openImport();
		} else if (target === 'pantry') {
			mobileNav = false;
			error = '';
			modal = 'pantry';
		} else {
			mobileNav = false;
			error = '';
			modal = '';
			if (page !== 'shopping') navigate('shopping');
		}
		voiceStarting = true;
		voiceTarget = target;
		activeVoiceImportSession = importSession;
		const owner = user?.id;
		const capture = new VoiceCapture({
			state: (value) => {
				if (voiceCapture !== capture) return;
				const focusInVoiceUi = isFocusManagedByVoice();
				voiceState = value;
				if (value === 'recording') {
					if (focusInVoiceUi) {
						void tick().then(() => {
							if (voiceCapture === capture && voiceState === 'recording') {
								voiceStopButton?.focus();
							}
						});
					}
				} else if (value === 'transcribing') {
					if (focusInVoiceUi) {
						void tick().then(() => {
							if (voiceCapture === capture && voiceState === 'transcribing') {
								voiceCancelButton?.focus();
							}
						});
					}
				} else if (value === 'idle') {
					voiceStarting = false;
					if (capture.hasRetainedAudio) {
						if (focusInVoiceUi) {
							void tick().then(() => {
								if (voiceCapture === capture && voiceRetained) {
									voiceRetryButton?.focus();
								}
							});
						}
					} else {
						const endedTarget = voiceTarget;
						const restoreEl =
							endedTarget === 'shopping'
								? (shoppingMicButton ?? voiceReturnFocus)
								: voiceReturnFocus;
						voiceTarget = '';
						voiceReturnFocus = null;
						if (focusInVoiceUi) {
							scheduleVoiceIdleFocus(endedTarget, restoreEl);
						}
					}
				}
			},
			retained: (value) => {
				if (voiceCapture === capture) voiceRetained = value;
			},
			text: (text) => {
				if (
					voiceCapture !== capture ||
					voiceTarget !== target ||
					!isVoiceTargetActive(target, {
						modal,
						page,
						overlay: voiceOverlay,
						reviewingDraft: isReviewingImportDraft(importSession)
					})
				)
					return;
				if (target === 'import') {
					if (
						!activeVoiceImportSession ||
						!canAppendImportTranscript({
							modal,
							currentSession: importSession,
							startedSession: activeVoiceImportSession,
							currentUserId: user?.id,
							startedUserId: owner
						})
					)
						return;
					voiceError = '';
					importSession.text = appendDictatedText('import', importSession.text, text);
				} else if (target === 'pantry') {
					if (user?.id !== owner) return;
					voiceError = '';
					pantryInput = appendDictatedText('pantry', pantryInput, text).slice(0, 20000);
					notify('Review your ingredients, then add them.');
				} else {
					if (user?.id !== owner) return;
					voiceError = '';
					shoppingText = appendDictatedText('shopping', shoppingText, text);
					shoppingVoiceInput = true;
					notify('Review your items, then add them.');
				}
			},
			error: (message) => {
				if (voiceCapture === capture) {
					voiceError = message;
					notify(message);
				}
			}
		});
		voiceCapture = capture;
		void tick().then(() => {
			if (voiceCapture === capture && isFocusManagedByVoice()) {
				if (voiceState === 'recording') voiceStopButton?.focus();
				else if (voiceStarting) voiceCancelButton?.focus();
			}
		});
		try {
			await capture.start({ provider: plan.provider, model: voiceModel, apiKey: voiceApiKey });
		} finally {
			if (voiceCapture === capture) {
				const focusInVoiceUi = isFocusManagedByVoice();
				voiceStarting = false;
				if (voiceState === 'idle' && !capture.hasRetainedAudio) {
					const endedTarget = voiceTarget;
					const restoreEl =
						endedTarget === 'shopping' ? (shoppingMicButton ?? voiceReturnFocus) : voiceReturnFocus;
					voiceTarget = '';
					voiceReturnFocus = null;
					if (focusInVoiceUi) {
						scheduleVoiceIdleFocus(endedTarget, restoreEl);
					}
				}
			}
		}
	}

	function saveRecipe(r: Recipe) {
		r.saved = !r.saved;
		delete r.sampleSaved;
		kitchen.recipes = [...kitchen.recipes];
		hasSampleRecords = hasSampleData(kitchen);
		notify(r.saved ? 'Saved to your collection.' : 'Removed from your collection.');
	}
	function toggleRecipeHidden(recipe: Recipe) {
		const hidden = !recipe.hidden;
		kitchen.recipes = kitchen.recipes.map((item) =>
			item.id === recipe.id ? { ...item, hidden } : item
		);
		selected = null;
		notify(
			hidden
				? `${recipe.title} hidden. Show hidden recipes to find it again.`
				: `${recipe.title} restored to your recipe list.`
		);
	}
	function openNewRecipe() {
		mobileNav = false;
		resetMealDialogState();
		resumeDialog = '';
		modal = '';
		error = '';
		selected = null;
		selectedMealServings = undefined;
		editingRecipeMode = 'create';
		editingRecipe = createBlankRecipe();
	}
	function editSavedRecipe(recipe: Recipe) {
		const saved = kitchen.recipes.find((item) => item.id === recipe.id && item.saved);
		if (!saved) return;
		selected = null;
		editingRecipeMode = 'edit';
		editingRecipe = {
			...saved,
			tags: [...saved.tags],
			ingredients: saved.ingredients.map((item) => ({ ...item })),
			steps: [...saved.steps],
			nutrition: { ...saved.nutrition }
		};
	}
	function saveEditedRecipe(updated: Recipe) {
		if (editingRecipeMode === 'create') {
			const saved = finalizeManualRecipe(updated);
			kitchen.recipes = insertRecipes(kitchen.recipes, [saved]);
			editingRecipe = null;
			editingRecipeMode = 'edit';
			selectedMealServings = undefined;
			selected = kitchen.recipes.find((item) => item.id === saved.id) ?? saved;
			page = 'saved';
			priorityPantryIds = [];
			query = '';
			filter = 'For you';
			notify('Recipe saved to your collection.');
			return;
		}
		const previous = kitchen.recipes.find((item) => item.id === updated.id);
		if (!previous || !previous.saved) {
			editingRecipe = null;
			return;
		}
		const nutritionNeedsRefresh =
			previous.servings !== updated.servings ||
			JSON.stringify(previous.ingredients) !== JSON.stringify(updated.ingredients);
		const nutritionChanged =
			JSON.stringify(previous.nutrition) !== JSON.stringify(updated.nutrition);
		const zeroNutrition = hasZeroNutrition(updated.nutrition);
		const { sampleSaved: _sampleSaved, ...cleanUpdated } = updated;
		const saved = {
			...cleanUpdated,
			saved: true,
			nutritionStale: nutritionNeedsRefresh
				? true
				: updated.provenance === 'manual' && zeroNutrition
					? true
					: nutritionChanged && !zeroNutrition
						? false
						: previous.nutritionStale
		};
		kitchen.recipes = kitchen.recipes.map((item) => (item.id === saved.id ? saved : item));
		hasSampleRecords = hasSampleData(kitchen);
		editingRecipe = null;
		notify(
			nutritionNeedsRefresh ? 'Recipe updated. Refresh its nutrition estimate.' : 'Recipe updated.'
		);
	}
	function askDeleteRecipe(recipe: Recipe) {
		if (!recipe.saved) return;
		recipeToDelete = recipe;
		selected = null;
		modal = 'deleteRecipe';
	}
	function weekStartForDate(value: string) {
		const date = new Date(`${value}T12:00:00`);
		if (Number.isNaN(date.getTime())) return value;
		date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
		return dateKey(date);
	}
	function weekOffsetForDate(value: string, today = new Date()) {
		const start = weekStartForDate(value);
		if (start === value && Number.isNaN(new Date(`${value}T12:00:00`).getTime())) return weekOffset;
		return weekOffsetFromStarts(start, weekStartForDate(dateKey(today)));
	}
	async function scrollCalendarToDate(targetDate: string, instant = false) {
		const token = ++calendarScrollToken;
		await tick();
		if (
			token !== calendarScrollToken ||
			page !== 'planner' ||
			!calendarGrid?.isConnected ||
			typeof window === 'undefined' ||
			typeof window.matchMedia !== 'function' ||
			!window.matchMedia('(max-width: 900px)').matches ||
			calendarGrid.scrollWidth <= calendarGrid.clientWidth
		) {
			return;
		}
		const dayCard =
			Array.from(calendarGrid.querySelectorAll<HTMLElement>('.calendar-day')).find(
				(day) => day.dataset.date === targetDate
			) ??
			(targetDate === dateKey(new Date())
				? calendarGrid.querySelector<HTMLElement>('.calendar-day.today')
				: null);
		if (!dayCard) return;
		const gridRect = calendarGrid.getBoundingClientRect();
		const dayRect = dayCard.getBoundingClientRect();
		const styles = window.getComputedStyle(calendarGrid);
		const scrollPaddingStart =
			Number.parseFloat(styles.scrollPaddingInlineStart) ||
			Number.parseFloat(styles.scrollPaddingLeft) ||
			0;
		const left = calendarDayScrollLeft({
			dayLeft: dayRect.left,
			gridLeft: gridRect.left,
			clientLeft: calendarGrid.clientLeft,
			scrollLeft: calendarGrid.scrollLeft,
			scrollPaddingStart,
			scrollWidth: calendarGrid.scrollWidth,
			clientWidth: calendarGrid.clientWidth
		});
		calendarGrid.scrollTo({
			left,
			behavior: instant || prefersReducedMotion() ? 'instant' : 'smooth'
		});
	}
	function showCurrentWeek() {
		weekOffset = 0;
		void scrollCalendarToDate(dateKey(new Date()));
	}
	function resetMealDialogState() {
		pickingForSlot = false;
		mealDate = '';
		mealSlot = 'Dinner';
		plannedServings = 2;
		editingMealId = '';
		cookingMealId = '';
		deductPantry = false;
		leftoverServings = 0;
	}
	function refreshWeekShopping(startDate: string) {
		kitchen.shopping = refreshWeekShoppingItems(kitchen, startDate);
		if (editingShoppingId && !kitchen.shopping.some((entry) => entry.id === editingShoppingId))
			clearEditingShoppingState();
	}
	function confirmDeleteRecipe() {
		const recipe = recipeToDelete;
		if (!recipe) return;
		const impactedMeals = kitchen.meals.filter((meal) => meal.recipeId === recipe.id);
		const affectedWeeks = new Set(impactedMeals.map((meal) => weekStartForDate(meal.date)));
		kitchen.meals = kitchen.meals.filter((meal) => meal.recipeId !== recipe.id);
		kitchen.recipes = kitchen.recipes.filter((item) => item.id !== recipe.id);
		hasSampleRecords = hasSampleData(kitchen);
		kitchen.shopping = kitchen.shopping.filter(
			(item) => item.sourceKey !== `recipe:${recipe.id}` || item.checked
		);
		if (editingShoppingId && !kitchen.shopping.some((entry) => entry.id === editingShoppingId))
			clearEditingShoppingState();
		if (kitchen.preferences.ratings) {
			const ratings = { ...kitchen.preferences.ratings };
			delete ratings[recipe.id];
			kitchen.preferences.ratings = ratings;
		}
		for (const startDate of affectedWeeks) refreshWeekShopping(startDate);
		recipeToDelete = null;
		modal = '';
		notify(
			`${recipe.title} deleted, along with ${impactedMeals.length} planned meal${impactedMeals.length === 1 ? '' : 's'}.`
		);
	}
	function shoppingSourceLabel(sourceKey?: string) {
		if (sourceKey?.startsWith('recipe:')) return 'Recipe';
		if (sourceKey?.startsWith('week:')) return 'Meal plan';
		return 'Added by you';
	}
	function commitInlineEdits() {
		if (pantryDraft) void savePantryEdit(false);
		if (editingShoppingId) {
			const item = kitchen.shopping.find((entry) => entry.id === editingShoppingId);
			if (item) applyShoppingEdit(item);
			clearEditingShoppingState();
		}
	}
	function addShoppingQuickItem() {
		const raw = shoppingText.trim();
		if (!raw) return;
		const parsed = parseQuickShoppingItems(raw, { split: shoppingVoiceInput });
		if (parsed.error) {
			notify(parsed.error);
			return;
		}
		const additions = parsed.items;
		if (!additions.length) return;
		if (kitchen.shopping.length >= 1_000) {
			notify('Your shopping list can hold up to 1,000 items.');
			return;
		}
		const available = 1_000 - kitchen.shopping.length;
		const accepted = additions.slice(0, available);
		const firstCheckedIndex = kitchen.shopping.findIndex((item) => item.checked);
		if (firstCheckedIndex === -1) {
			kitchen.shopping.push(...accepted);
		} else {
			kitchen.shopping.splice(firstCheckedIndex, 0, ...accepted);
		}
		shoppingText = '';
		shoppingVoiceInput = false;
		if (accepted.length < additions.length) {
			notify('Your shopping list can hold up to 1,000 items.');
		}
	}
	function movePurchasedToPantry() {
		commitInlineEdits();
		const checked = kitchen.shopping.filter((i) => i.checked);
		if (!checked.length) {
			notify('Mark items purchased first to move them to your pantry.');
			return;
		}
		const existingKeys = new Set(
			kitchen.pantry
				.filter((item) => !item.sample && !item.expires?.trim())
				.map(
					(item) => `${normalizeIngredientName(item.name)}\u0000${unitInfo(item.unit).dimension}`
				)
		);
		let lotCount = kitchen.pantry.length;
		const accepted: AppState['shopping'] = [];
		for (const item of checked) {
			const name = item.name.trim().slice(0, 200);
			const unit = item.unit.trim().slice(0, 40);
			if (!name || !unit || !Number.isFinite(item.quantity) || item.quantity <= 0) continue;
			const key = `${normalizeIngredientName(name)}\u0000${unitInfo(unit).dimension}`;
			if (!existingKeys.has(key)) {
				if (lotCount >= 1_000) continue;
				existingKeys.add(key);
				lotCount += 1;
			}
			accepted.push({
				...item,
				name,
				unit,
				quantity: Math.min(1_000_000, item.quantity)
			});
		}
		if (!accepted.length) {
			notify(
				kitchen.pantry.length >= 1_000
					? 'Your pantry can hold up to 1,000 ingredients.'
					: 'Enter a quantity above zero before moving purchased items.'
			);
			return;
		}
		const previousPantry = JSON.parse(JSON.stringify(kitchen.pantry)) as AppState['pantry'];
		const previousShopping = JSON.parse(JSON.stringify(kitchen.shopping)) as AppState['shopping'];
		const updated = movePurchasesToPantry(kitchen);
		kitchen.pantry = updated.pantry;
		kitchen.shopping = updated.shopping;
		if (editingShoppingId && !kitchen.shopping.some((entry) => entry.id === editingShoppingId))
			clearEditingShoppingState();
		const appliedPantry = JSON.stringify(kitchen.pantry);
		const appliedShopping = JSON.stringify(kitchen.shopping);
		notify(
			`${accepted.length} purchased item${accepted.length === 1 ? '' : 's'} moved to your pantry.`,
			() => {
				if (
					JSON.stringify(kitchen.pantry) === appliedPantry &&
					JSON.stringify(kitchen.shopping) === appliedShopping
				) {
					kitchen.pantry = previousPantry;
					kitchen.shopping = previousShopping;
					if (
						editingShoppingId &&
						!kitchen.shopping.some((entry) => entry.id === editingShoppingId)
					)
						clearEditingShoppingState();
				} else {
					notify('Your kitchen changed again. Review the current values before editing.');
				}
			}
		);
	}
	function shoppingFor(items: Recipe[], meals: AppState['meals'] | undefined, sourceKey: string) {
		if (meals?.some((meal) => !Number.isFinite(meal.servings) || meal.servings <= 0)) {
			notify('Enter a valid serving count before making a shopping list.');
			return;
		}
		commitInlineEdits();
		const additions = buildShoppingList(items, kitchen.pantry, meals);
		const { shopping, uncheckedCount } = shopForScope(kitchen.shopping, additions, sourceKey);
		kitchen.shopping = shopping;
		if (editingShoppingId && !kitchen.shopping.some((entry) => entry.id === editingShoppingId))
			clearEditingShoppingState();
		selected = null;
		page = 'shopping';
		notify(
			uncheckedCount
				? 'Shopping list ready. Your pantry is already accounted for.'
				: 'You have everything you need. Happy cooking!'
		);
	}
	function openRecipePicker(slotTarget?: { date: string; slot: string }) {
		resetMealDialogState();
		selected = null;
		selectedMealServings = undefined;
		if (slotTarget) {
			pickingForSlot = true;
			mealDate = slotTarget.date;
			mealSlot = slotTarget.slot;
		} else {
			mealDate = dateKey(new Date());
			mealSlot = 'Dinner';
		}
		modal = 'pickRecipe';
	}
	function choosePickedRecipe(recipe: Recipe) {
		if (pickingForSlot && mealDate && ['Breakfast', 'Lunch', 'Dinner'].includes(mealSlot)) {
			const scheduledDate = mealDate;
			const scheduledSlot = mealSlot;
			const scheduledWeek = weekStartForDate(scheduledDate);
			const servings = isValidServings(recipe.servings) ? recipe.servings : 2;
			const created: Meal = {
				id: crypto.randomUUID(),
				date: scheduledDate,
				slot: scheduledSlot,
				recipeId: recipe.id,
				servings
			};
			kitchen.meals.push(created);
			refreshWeekShopping(scheduledWeek);
			weekOffset = weekOffsetForDate(scheduledDate);
			if (page !== 'planner') pendingPlannerScrollDate = scheduledDate;
			selectedMealServings = undefined;
			selected = null;
			resetMealDialogState();
			modal = '';
			page = 'planner';
			void scrollCalendarToDate(scheduledDate);
			notify(`${recipe.title} scheduled.`, () => {
				const existing = kitchen.meals.find((entry) => entry.id === created.id);
				if (!existing) return;
				const affectedWeek = weekStartForDate(existing.date);
				kitchen.meals = kitchen.meals.filter((entry) => entry.id !== created.id);
				refreshWeekShopping(affectedWeek);
				if (affectedWeek !== scheduledWeek) refreshWeekShopping(scheduledWeek);
			});
			return;
		}
		planRecipe(recipe, recipe.servings);
	}
	function planRecipe(r: Recipe, servings = r.servings) {
		resetMealDialogState();
		plannedServings = servings;
		selected = r;
		mealDate = dateKey(new Date());
		mealSlot = 'Dinner';
		modal = 'plan';
	}
	function editPlannedMeal(meal: Meal) {
		if (meal.completedAt) return;
		resetMealDialogState();
		editingMealId = meal.id;
		mealDate = meal.date;
		mealSlot = meal.slot;
		plannedServings = meal.servings;
		modal = 'editMeal';
	}
	function saveMealChanges(event?: SubmitEvent) {
		event?.preventDefault();
		const meal = kitchen.meals.find((item) => item.id === editingMealId);
		if (!meal || !mealDate || !['Breakfast', 'Lunch', 'Dinner'].includes(mealSlot)) return;
		if (!isValidServings(plannedServings)) {
			notify(`Choose between 1 and ${MAX_SERVINGS.toLocaleString('en-US')} whole servings.`);
			return;
		}
		const previousWeek = weekStartForDate(meal.date);
		const updatedDate = mealDate;
		meal.date = updatedDate;
		meal.slot = mealSlot;
		meal.servings = Math.round(plannedServings);
		delete meal.sample;
		hasSampleRecords = hasSampleData(kitchen);
		refreshWeekShopping(previousWeek);
		refreshWeekShopping(weekStartForDate(meal.date));
		weekOffset = weekOffsetForDate(updatedDate);
		resetMealDialogState();
		modal = '';
		void scrollCalendarToDate(updatedDate);
		notify('Meal plan updated.');
	}
	function openCookDialog(meal: Meal) {
		if (meal.completedAt) return;
		resetMealDialogState();
		cookingMealId = meal.id;
		deductPantry = false;
		leftoverServings = 0;
		modal = 'cookMeal';
	}
	function markMealCooked(event?: SubmitEvent) {
		event?.preventDefault();
		const meal = kitchen.meals.find((item) => item.id === cookingMealId);
		if (!meal) return;
		if (
			!Number.isInteger(leftoverServings) ||
			leftoverServings < 0 ||
			leftoverServings > meal.servings
		) {
			notify(`Enter whole leftovers between 0 and ${meal.servings} servings.`);
			return;
		}
		const recipeId = meal.recipeId;
		const servingsCooked = meal.servings;
		const startDate = weekStartForDate(meal.date);
		kitchen = completeMeal(kitchen, meal.id, {
			deductPantry,
			leftoverServings: Math.round(leftoverServings)
		});
		hasSampleRecords = hasSampleData(kitchen);
		refreshWeekShopping(startDate);
		resetMealDialogState();
		modal = '';
		const recipe = kitchen.recipes.find((item) => item.id === recipeId);
		selectedMealServings = servingsCooked;
		if (recipe) selected = recipe;
		notify(recipe ? `Marked cooked. How did you like ${recipe.title}?` : 'Meal marked cooked.');
	}
	function restockPantryItems(selectedIds?: string[]) {
		commitInlineEdits();
		const previousPantry = JSON.parse(JSON.stringify(kitchen.pantry)) as AppState['pantry'];
		const previousShopping = JSON.parse(JSON.stringify(kitchen.shopping)) as AppState['shopping'];
		const result = restockDepletedPantryItems(kitchen.pantry, kitchen.shopping, selectedIds);
		if (!result.restockedCount) return;
		kitchen.pantry = result.pantry;
		kitchen.shopping = result.shopping;
		hasSampleRecords = hasSampleData(kitchen);
		const appliedPantry = JSON.stringify(kitchen.pantry);
		const appliedShopping = JSON.stringify(kitchen.shopping);
		const singleName =
			selectedIds?.length === 1
				? previousPantry.find((item) => item.id === selectedIds[0])?.name
				: undefined;
		const message = singleName
			? result.addedCount
				? `${singleName} added to your shopping list.`
				: `${singleName} is already on your shopping list.`
			: result.addedCount
				? `${result.addedCount} depleted item${result.addedCount === 1 ? '' : 's'} added to your shopping list.`
				: 'Depleted items are already on your shopping list.';
		notify(message, () => {
			if (
				JSON.stringify(kitchen.pantry) === appliedPantry &&
				JSON.stringify(kitchen.shopping) === appliedShopping
			) {
				kitchen.pantry = previousPantry;
				kitchen.shopping = previousShopping;
				hasSampleRecords = hasSampleData(kitchen);
				if (editingShoppingId && !kitchen.shopping.some((entry) => entry.id === editingShoppingId))
					clearEditingShoppingState();
			} else {
				notify('Your kitchen changed again. Review the current items before editing.');
			}
		});
	}
	function useFirstIngredients(items: AppState['pantry']) {
		commitInlineEdits();
		const targetIds = new Set(items.map((item) => item.id));
		const targets = kitchen.pantry.filter(
			(item) =>
				targetIds.has(item.id) &&
				expiryStatus(item.expires) === 'soon' &&
				Number.isFinite(item.quantity) &&
				item.quantity > 0 &&
				item.name.trim()
		);
		if (!targets.length) return;
		const names = targets.map((item) => item.name.trim());
		prompt = `Use these ingredients first, prioritizing them because they are expiring: ${names.join(', ')}. Build a practical recipe that uses as much of them as possible while following my preferences.`;
		priorityPantryIds = targets.map((item) => item.id);
		query = '';
		lastActivePill = 'filter';
		filter = PANTRY_FILTER;
		navigate('discover');
	}
	function cookFromPantry() {
		commitInlineEdits();
		const stockedNames = kitchen.pantry
			.filter(
				(item) =>
					Number.isFinite(item.quantity) &&
					item.quantity > 0 &&
					expiryStatus(item.expires) !== 'expired' &&
					!(Boolean(item.expires?.trim()) && expiryStatus(item.expires) === 'unknown') &&
					item.name.trim()
			)
			.map((item) => item.name.trim());
		prompt = stockedNames.length
			? `Build practical recipes around what is currently in my pantry: ${stockedNames.slice(0, 12).join(', ')}.`
			: '';
		priorityPantryIds = [];
		query = '';
		lastActivePill = 'filter';
		filter = PANTRY_FILTER;
		navigate('discover');
	}
	function addMeal(event?: SubmitEvent) {
		event?.preventDefault();
		if (!selected || !mealDate || !['Breakfast', 'Lunch', 'Dinner'].includes(mealSlot)) return;
		if (!isValidServings(plannedServings)) {
			notify(`Choose between 1 and ${MAX_SERVINGS.toLocaleString('en-US')} whole servings.`);
			return;
		}
		const scheduledDate = mealDate;
		kitchen.meals.push({
			id: crypto.randomUUID(),
			date: scheduledDate,
			slot: mealSlot,
			recipeId: selected.id,
			servings: plannedServings
		});
		refreshWeekShopping(weekStartForDate(scheduledDate));
		weekOffset = weekOffsetForDate(scheduledDate);
		if (page !== 'planner') pendingPlannerScrollDate = scheduledDate;
		selectedMealServings = undefined;
		selected = null;
		resetMealDialogState();
		modal = '';
		page = 'planner';
		void scrollCalendarToDate(scheduledDate);
		notify('Meal scheduled.');
	}
	function applyHouseholdRoster(data: {
		members?: HouseholdMember[];
		invites?: HouseholdInvite[];
		canManage?: boolean;
	}) {
		members = data.members ?? [];
		householdInvites = data.invites ?? [];
		canManageHousehold = Boolean(data.canManage);
		if (
			currentInviteId &&
			!householdInvites.some((invite) => invite.inviteId === currentInviteId)
		) {
			currentInviteId = '';
			inviteCode = '';
		}
	}
	async function refreshHousehold() {
		const data = await request('/api/household');
		applyHouseholdRoster(data);
		return data;
	}
	async function household() {
		mobileNav = false;
		if (!user) {
			openAuthentication();
			return;
		}
		modal = 'household';
		error = '';
		householdBusy = true;
		try {
			await refreshHousehold();
		} catch (e) {
			error = (e as Error).message;
		} finally {
			householdBusy = false;
		}
	}
	async function invite() {
		if (!canManageHousehold) return;
		householdBusy = true;
		error = '';
		try {
			const result = await request('/api/household', { action: 'createInvite' });
			inviteCode = result.inviteCode;
			currentInviteId = result.inviteId;
			await refreshHousehold();
			notify('Invite ready. Share it with someone you cook with.');
		} catch (e) {
			error = (e as Error).message;
		} finally {
			householdBusy = false;
		}
	}
	async function revokeInvite(inviteId: string) {
		if (!canManageHousehold) return;
		householdBusy = true;
		error = '';
		try {
			await request('/api/household', { action: 'revokeInvite', inviteId });
			if (currentInviteId === inviteId) {
				currentInviteId = '';
				inviteCode = '';
			}
			await refreshHousehold();
			notify('Invitation revoked.');
		} catch (e) {
			error = (e as Error).message;
		} finally {
			householdBusy = false;
		}
	}
	function askRemoveMember(member: HouseholdMember) {
		if (!canManageHousehold || member.role === 'owner' || member.id === user?.id) return;
		memberToRemove = member;
		modal = 'removeMember';
		error = '';
	}
	async function confirmRemoveMember() {
		if (!canManageHousehold || !memberToRemove) return;
		householdBusy = true;
		error = '';
		try {
			await request('/api/household', {
				action: 'removeMember',
				memberId: memberToRemove.id
			});
			await refreshHousehold();
			modal = 'household';
			memberToRemove = null;
			notify('Member removed from the household.');
		} catch (e) {
			error = (e as Error).message;
		} finally {
			householdBusy = false;
		}
	}
	async function openLeaveHousehold() {
		mobileNav = false;
		if (!user) {
			openAuthentication();
			return;
		}
		error = '';
		householdBusy = true;
		try {
			const data = await refreshHousehold();
			if ((data.members ?? []).length <= 1) {
				modal = 'household';
				notify('You already have your own personal kitchen.');
			} else {
				modal = 'leave';
			}
		} catch (e) {
			modal = 'household';
			error = (e as Error).message;
		} finally {
			householdBusy = false;
		}
	}
	async function join(confirmReplace = false) {
		const confirmed = confirmReplace === true;
		householdBusy = true;
		error = '';
		let joinedHousehold = false;
		try {
			syncing = true;
			clearTimeout(saveTimer);
			await flushKitchen();
			await runHouseholdTransition({
				mutateHousehold: () =>
					request('/api/household', {
						action: 'join',
						code: joinCode.trim(),
						...(confirmed ? { confirmReplace: true } : {})
					}),
				onMutated: () => {
					joinedHousehold = true;
					kitchenSync?.clearContext();
					clearAIConnectionState();
					clearHouseholdViewState();
					stateEtag = null;
					kitchen = createNewUserState();
					hasSampleRecords = false;
					joinCode = '';
					inviteCode = '';
					currentInviteId = '';
				},
				refreshAuth,
				fetchState: () => request('/api/state'),
				adoptState: (data) => adoptKitchen(data.state || createNewUserState()),
				applyRoster: applyHouseholdRoster
			});
			modal = 'household';
			syncing = false;
			notify('Welcome to your shared kitchen.');
		} catch (e) {
			syncing = false;
			const err = e as Error & { status?: number; code?: string };
			if (!confirmed && err.status === 409 && err.code === 'confirm_replace') {
				error = '';
				modal = 'confirmJoin';
				return;
			}
			if (joinedHousehold) modal = 'household';
			error = err.message;
		} finally {
			syncing = false;
			householdBusy = false;
		}
	}
	async function refreshNutrition() {
		if (!selected || !(await needAI())) return;
		busy = true;
		try {
			const result = await ai('nutrition', { recipe: selected });
			selected.nutrition = result.nutrition;
			selected.nutritionStale = false;
			kitchen.recipes = [...kitchen.recipes];
			notify('Nutrition estimate refreshed, per serving.');
		} catch (e) {
			notify((e as Error).message);
		} finally {
			busy = false;
		}
	}
	let recipeEditor = $state<RecipeEditor>();
	function closeRecipeDetail() {
		selected = null;
		selectedMealServings = undefined;
	}
	function closeRecipeEditor() {
		editingRecipe = null;
		editingRecipeMode = 'edit';
		error = '';
	}
	function closeDialog() {
		if (
			modal === 'settings' &&
			(connectionActive ||
				connectionPoll?.active ||
				connectionPopup ||
				chatGPTDevice ||
				chatGPTAuthorizationUrl)
		) {
			void cancelChatGPTDevice();
		}
		if (modal === 'plan') {
			selected = null;
			selectedMealServings = undefined;
		}
		if (
			modal === 'plan' ||
			modal === 'pickRecipe' ||
			modal === 'editMeal' ||
			modal === 'cookMeal'
		) {
			resetMealDialogState();
		}
		if (modal === 'deleteRecipe') recipeToDelete = null;
		if (modal === 'removeMember') memberToRemove = null;
		if (modal === 'household') {
			inviteCode = '';
			currentInviteId = '';
		}
		if ((modal === 'pantry' || modal === 'import') && voiceTarget === modal) {
			clearVoiceSession(false);
		}
		if (modal === 'onboarding') dismissOnboarding();
		else if (modal) {
			const next = resolveClosedDialog(modal, resumeDialog);
			resumeDialog = next.resumeDialog;
			modal = next.modal;
		}
		error = '';
	}
	function handleWindowKeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape' || e.defaultPrevented) return;
		if (modal) {
			e.preventDefault();
			closeDialog();
		} else if (editingRecipe) {
			e.preventDefault();
			if (recipeEditor) void recipeEditor.requestCancel();
			else closeRecipeEditor();
		} else if (selected) {
			e.preventDefault();
			closeRecipeDetail();
		} else if (butlerOpen) {
			e.preventDefault();
			void butlerChat?.close();
		} else if (mobileNav) {
			e.preventDefault();
			mobileNav = false;
		} else if (page === 'shopping' && voiceTarget === 'shopping' && voiceBusy) {
			e.preventDefault();
			clearVoiceSession();
		} else if (page === 'shopping' && editingShoppingId) {
			e.preventDefault();
			void cancelEditingShoppingItem();
		} else if (pantryDraft) {
			e.preventDefault();
			void cancelPantryEdit();
		}
	}
	function openImport(text?: string) {
		resumeDialog = '';
		if (text !== undefined) {
			if (voiceTarget === 'import') clearVoiceSession();
			importSession = { ...emptyImportSession(), text };
		}
		error = '';
		mobileNav = false;
		modal = 'import';
	}
	function importRecipe(url: string) {
		if (voiceTarget === 'import') clearVoiceSession();
		const { session, previous } = replaceImportSessionWithUrl($state.snapshot(importSession), url);
		importSession = session;
		openImport();
		if (previous) {
			notify('Recipe link loaded. Undo to restore your previous import.', () => {
				if (voiceTarget === 'import') clearVoiceSession();
				importSession = cloneImportSession(previous);
				resumeDialog = '';
				error = '';
				modal = 'import';
			});
		}
	}
	async function captureImport(
		input: { url?: string; prompt: string; image?: string },
		signal: AbortSignal
	) {
		const explicitUrl = input.url?.trim() || undefined;
		const trimmedPrompt = input.prompt.trim();
		const standaloneUrl = !input.image
			? explicitUrl
				? !trimmedPrompt
					? explicitUrl
					: undefined
				: isStandaloneRecipeUrl(trimmedPrompt)
					? trimmedPrompt
					: undefined
			: undefined;
		if (standaloneUrl) {
			const connected = hasAIConnection();
			return request(
				'/api/recipe-import',
				{
					url: standaloneUrl,
					...(connected
						? {
								...(kitchen.preferences.provider === 'chatgpt'
									? { connectionId: kitchen.preferences.chatgptAccountId }
									: { apiKey }),
								provider: kitchen.preferences.provider,
								model: kitchen.preferences.model,
								reasoning: kitchen.preferences.reasoning
							}
						: {})
				},
				'POST',
				signal
			);
		}
		if (!(await needAI())) {
			resumeDialog = 'import';
			return null;
		}
		return ai('capture', input, signal);
	}
	function saveImportedRecipe(recipe: Recipe) {
		const previousPage = page;
		const previousQuery = query;
		const previousFilter = filter;
		const applied = applyImportedRecipeSave(
			$state.snapshot(kitchen),
			$state.snapshot(importSession),
			recipe
		);
		kitchen.recipes = applied.nextRecipes;
		if (voiceTarget === 'import') clearVoiceSession();
		importSession = applied.nextSession;
		resumeDialog = '';
		modal = '';
		selected = applied.saved;
		page = 'saved';
		query = '';
		filter = 'For you';
		notify(
			applied.saved.nutritionStale
				? 'Recipe saved to your collection. Refresh its nutrition estimate.'
				: 'Recipe saved to your collection.',
			() => {
				const rolledBack = applied.rollback($state.snapshot(kitchen));
				if (!rolledBack.ok) {
					notify('Your kitchen changed again. Review the current values before editing.');
					return;
				}
				if (voiceTarget === 'import') clearVoiceSession();
				kitchen = rolledBack.kitchen;
				if (selected?.id === applied.saved.id) {
					selected = null;
					selectedMealServings = undefined;
				}
				if (editingRecipeMode === 'edit' && editingRecipe?.id === applied.saved.id) {
					editingRecipe = null;
					editingRecipeMode = 'edit';
				}
				importSession = rolledBack.session;
				resumeDialog = '';
				error = '';
				page = previousPage;
				query = previousQuery;
				filter = previousFilter;
				modal = 'import';
			}
		);
	}
	async function exportKitchen() {
		if (exporting) return;
		exporting = true;
		try {
			commitInlineEdits();
			const currentUser = user ? ($state.snapshot(user) as User) : null;
			const currentState = $state.snapshot(kitchen) as AppState;
			if (ready && currentUser && (!managedAuth || kitchenLoaded)) {
				kitchenSync?.stage(sanitizeKitchenState(currentState));
			}
			const result = await exportKitchenArchive({
				user: currentUser,
				state: currentState,
				online: online && navigator.onLine,
				pendingSnapshot: currentUser ? (kitchenSync?.snapshot() ?? null) : null,
				hasPendingSync: currentUser ? pendingSync : false,
				storage: currentUser ? localStorage : null,
				fetcher: currentUser ? fetch : undefined
			});
			download(result.json, result.filename, 'application/json');
			notify(result.notice);
		} catch (e) {
			notify((e as Error).message || 'Could not export your kitchen.');
		} finally {
			exporting = false;
		}
	}
	function download(content: string, filename: string, type: string) {
		const url = URL.createObjectURL(new Blob([content], { type }));
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		a.click();
		URL.revokeObjectURL(url);
	}
	async function deleteAccount(event: SubmitEvent) {
		event.preventDefault();
		if (managedAuth) return;
		busy = true;
		error = '';
		try {
			syncing = true;
			clearTimeout(saveTimer);
			await writeChain;
			await request('/api/auth', { action: 'deleteAccount', password: deletePassword });
			cancelScan(true);
			if (user) {
				for (const key of Object.keys(localStorage)) {
					if (key.startsWith('flavorithm-') && key.includes(`:${user.id}:`))
						localStorage.removeItem(key);
				}
			}
			kitchenSync?.clearContext();
			clearHouseholdViewState();
			localStorage.removeItem('flavorithm-last-account');
			user = null;
			editingRecipe = null;
			editingRecipeMode = 'edit';
			inviteCode = '';
			currentInviteId = '';
			joinCode = '';
			members = [];
			householdInvites = [];
			canManageHousehold = false;
			clearVoiceSession();
			pantryInput = '';
			importSession = emptyImportSession();
			resumeDialog = '';
			clearAIConnectionState();
			deletePassword = '';
			stateEtag = null;
			kitchen = createInitialState();
			hasSampleRecords = true;
			cookedHistoryLimit = COOKED_HISTORY_PAGE_SIZE;
			clearGuestData(localStorage);
			quarantineLegacyKitchen(localStorage);
			syncing = false;
			modal = '';
			notify('Your account and personal data have been deleted.');
		} catch (e) {
			error = (e as Error).message;
			syncing = false;
		} finally {
			busy = false;
		}
	}
	async function sendEmailVerification() {
		if (!user || user.emailVerified || !capabilities.emailDelivery) return;
		verificationBusy = true;
		error = '';
		try {
			await request('/api/auth', { action: 'requestEmailVerification' });
			await refreshAuth();
			notify('If your email needs verification, a link is on its way.');
		} catch (e) {
			error = (e as Error).message;
		} finally {
			verificationBusy = false;
		}
	}
	async function recover(event: SubmitEvent) {
		event.preventDefault();
		if (managedAuth) {
			openAuthentication();
			return;
		}
		if (modal !== 'reset' && !capabilities.emailDelivery) {
			error =
				'Password recovery is unavailable. Ask the server operator to configure email delivery.';
			return;
		}
		busy = true;
		error = '';
		try {
			if (modal === 'reset') {
				await request('/api/auth', { action: 'resetPassword', token: resetToken, password });
				password = '';
				resetToken = '';
				modal = 'auth';
				authMode = 'login';
				notify('Password reset. Sign in with your new password.');
			} else {
				await request('/api/auth', { action: 'requestPasswordReset', email });
				notify('If an account exists, a reset link is on its way.');
				modal = 'auth';
				authMode = 'login';
			}
		} catch (e) {
			error = (e as Error).message;
		} finally {
			busy = false;
		}
	}
	async function leaveHousehold() {
		busy = true;
		householdBusy = true;
		error = '';
		let leftHousehold = false;
		try {
			syncing = true;
			clearTimeout(saveTimer);
			await flushKitchen();
			await runHouseholdTransition({
				mutateHousehold: () => request('/api/household', { action: 'leave' }),
				onMutated: () => {
					leftHousehold = true;
					kitchenSync?.clearContext();
					clearAIConnectionState();
					clearHouseholdViewState();
					stateEtag = null;
					kitchen = createNewUserState();
					hasSampleRecords = false;
					joinCode = '';
					inviteCode = '';
					currentInviteId = '';
					memberToRemove = null;
				},
				refreshAuth,
				fetchState: () => request('/api/state'),
				adoptState: (data) => adoptKitchen(data.state || createNewUserState()),
				applyRoster: applyHouseholdRoster
			});
			syncing = false;
			modal = '';
			notify('You now have your own kitchen.');
		} catch (e) {
			syncing = false;
			if (leftHousehold) modal = 'household';
			error = (e as Error).message;
		} finally {
			syncing = false;
			busy = false;
			householdBusy = false;
		}
	}

	async function exportList() {
		if (!kitchen.shopping.length) return;
		const text = kitchen.shopping
			.map((i) => `${i.checked ? '✓' : '☐'} ${i.quantity} ${i.unit} ${i.name}`)
			.join('\n');
		const shareData = { title: 'Shopping list', text };
		if (
			typeof navigator.share === 'function' &&
			(typeof navigator.canShare !== 'function' || navigator.canShare(shareData))
		) {
			try {
				await navigator.share(shareData);
				return;
			} catch (e) {
				if ((e as { name?: string })?.name === 'AbortError') return;
			}
		}
		if (typeof navigator.clipboard?.writeText === 'function') {
			try {
				await navigator.clipboard.writeText(text);
				notify('Shopping list copied.');
				return;
			} catch {
				/* Fall back to file download when clipboard access is unavailable. */
			}
		}
		download(text, 'flavorithm-shopping.txt', 'text/plain');
	}
	async function internetSearch() {
		if (!capabilities.recipeSearch) {
			error = 'Web recipe search is not configured for this kitchen.';
			return;
		}
		if (!user) {
			openAuthentication();
			return;
		}
		busy = true;
		error = '';
		try {
			searchResults = (await ai('search', { prompt: prompt || 'seasonal weeknight recipes' }))
				.results;
		} catch (e) {
			error = (e as Error).message;
		} finally {
			busy = false;
		}
	}
</script>

{#snippet voiceSession()}
	{#if voiceBusy}<div class="voice-session" bind:this={voiceSessionEl} in:revealMotion>
			<p role="status" aria-live="polite">
				{voiceStarting
					? 'Opening microphone…'
					: voiceState === 'recording'
						? 'Listening… up to 2 minutes'
						: 'Transcribing…'}
			</p>
			<div class="dialog-actions">
				{#if voiceState === 'recording'}<button
						bind:this={voiceStopButton}
						type="button"
						class="primary"
						onclick={() => voiceCapture?.stop()}>Stop recording</button
					>{/if}<button
					bind:this={voiceCancelButton}
					type="button"
					class="secondary"
					onclick={() => clearVoiceSession()}>Cancel voice</button
				>
			</div>
		</div>{:else if voiceRetained}<div
			class="voice-session voice-recovery"
			bind:this={voiceSessionEl}
			in:revealMotion
		>
			<p class="voice-error-copy" role="alert">
				{voiceError || 'Voice transcription failed. Your recording is ready to retry.'}
			</p>
			<p class="voice-recovery-note">
				Your recording is kept in this tab so you can retry without speaking again.
			</p>
			<div class="dialog-actions voice-recovery-actions">
				<button
					bind:this={voiceRetryButton}
					class="primary"
					type="button"
					onclick={() => {
						void retryVoiceTranscription();
					}}><RefreshCw size={16} /> Retry transcription</button
				><button class="secondary" type="button" onclick={openVoiceSettings}
					><Settings size={16} /> Open Settings</button
				><button class="text-button" type="button" onclick={discardVoiceRecording}
					>Discard recording</button
				>
			</div>
		</div>{/if}
{/snippet}

{#if ready}
	<div inert={!!modal || !!selected || !!editingRecipe || mobileDrawerOpen}>
		<ButlerChat
			bind:this={butlerChat}
			bind:open={butlerOpen}
			{kitchen}
			owner={`${user?.id ?? 'guest'}:${user?.householdId ?? ''}`}
			request={askButler}
			apply={applyButler}
			userName={user?.name ?? ''}
			syncing={sendingSync}
			{pendingSync}
		/>
	</div>
{/if}

<svelte:head
	><title>{nav.find((item) => item.id === page)?.name || 'Discover'} · Flavorithm</title
	></svelte:head
>
<svelte:window onkeydown={handleWindowKeydown} />
<input
	class="visually-hidden"
	tabindex="-1"
	inert={(!!modal && modal !== 'pantry') ||
		!!selected ||
		!!editingRecipe ||
		butlerOpen ||
		mobileDrawerOpen}
	type="file"
	accept="image/jpeg,image/png,image/webp"
	aria-label="Scan pantry ingredients from a photo"
	bind:this={imageInput}
	onchange={scan}
	disabled={scanBusy || busy || voiceBusy}
/>
<a
	class="skip-link"
	inert={!!modal || !!selected || !!editingRecipe || butlerOpen || mobileDrawerOpen}
	href="#kitchen-content">Skip to kitchen content</a
>
<div class="app-shell" inert={!!modal || !!selected || !!editingRecipe || butlerOpen}>
	<MobileDrawer
		open={mobileNav}
		modal={mobileDrawerOpen}
		hidden={mobileViewport && !mobileNav}
		trigger={mobileMenuButton}
		onclose={() => (mobileNav = false)}
	>
		<a class="brand" href="/" aria-label="Flavorithm home"
			><img src="/favicon.svg" alt="" /><span>flavorithm<span class="brand-dot">✳</span></span></a
		>
		<nav>
			{#each nav as item}<button
					class:current={page === item.id}
					aria-current={page === item.id ? 'page' : undefined}
					onclick={() => navigate(item.id)}
					><item.icon size={19} strokeWidth={1.65} /><span>{item.name}</span
					>{#if item.id === 'shopping' && kitchen.shopping.filter((i) => !i.checked).length}<small
							>{kitchen.shopping.filter((i) => !i.checked).length}</small
						>{/if}</button
				>{/each}
		</nav>
		<div class="bottom-nav">
			<button onclick={household}><Users size={18} /> My household <Plus size={15} /></button
			><button onclick={() => openSettings()}><Settings size={18} /> Settings & themes</button
			><ToggleButton
				pressed={kitchen.preferences.dark}
				onclick={() => {
					kitchen.preferences.dark = !kitchen.preferences.dark;
				}}
				>{#if kitchen.preferences.dark}<Sun size={18} aria-hidden="true" />{:else}<Moon
						size={18}
						aria-hidden="true"
					/>{/if}Dark mode<span
					class="mode-toggle"
					class:on={kitchen.preferences.dark}
					aria-hidden="true"
				></span></ToggleButton
			>
		</div>
		<button class="profile-button" onclick={() => (user ? openSettings() : openAuthentication())}
			><span class="profile-avatar">{user ? user.name.slice(0, 1).toUpperCase() : 'Y'}</span><span
				><b>{user?.name || (managedAuth ? 'Managed by provider' : 'Sign in')}</b><small
					>{user
						? 'Account settings'
						: managedAuth
							? 'Organization access'
							: 'Save your pantry and recipes'}</small
				></span
			><ArrowUpRight size={16} /></button
		>
	</MobileDrawer>
	<main id="kitchen-content" tabindex="-1" inert={mobileDrawerOpen}>
		<header class="topbar">
			<button
				class="icon-button mobile-menu"
				bind:this={mobileMenuButton}
				aria-expanded={mobileNav}
				aria-controls="kitchen-sidebar"
				onclick={() => (mobileNav = !mobileNav)}
				aria-label="Toggle navigation"><Menu size={22} /></button
			>
			<div class="breadcrumb">
				<b>{nav.find((n) => n.id === page)?.name || 'Discover'}</b>
			</div>
			<div class="topbar-actions">
				<ToggleButton
					class="icon-button"
					label="Dark color mode"
					pressed={kitchen.preferences.dark}
					onclick={() => (kitchen.preferences.dark = !kitchen.preferences.dark)}
					>{#if kitchen.preferences.dark}<Sun size={18} aria-hidden="true" />{:else}<Moon
							size={18}
							aria-hidden="true"
						/>{/if}</ToggleButton
				><button
					class="top-avatar"
					aria-label={user ? 'Open household and account' : 'Sign in or create an account'}
					onclick={() => (user ? household() : openAuthentication())}
					><span aria-hidden="true">{user?.name.slice(0, 1) || 'Y'}</span></button
				>
			</div>
		</header>
		<div class="main-content">
			{#if user}<SyncStatus
					{kitchen}
					{online}
					ready={syncReady}
					pending={pendingSync}
					syncing={sendingSync}
					{conflicts}
					error={syncErrors}
					retry={() => {
						void reconnectKitchen();
					}}
					resolve={(choice) => {
						void retrySync(choice, reviewedEtag);
					}}
					exportPending={exportPendingChanges}
				/>{/if}
			{#if showStarter && hasSampleRecords}<div class="starter-note">
					<span><Sparkles size={14} /> Sample kitchen</span><button onclick={freshKitchen}
						>Start fresh <ArrowRight size={13} /></button
					><button
						aria-label="Dismiss sample kitchen notice"
						onclick={() => {
							showStarter = false;
							localStorage.setItem('flavorithm-started', 'yes');
						}}><X size={13} /></button
					>
				</div>{/if}
			{#if page === 'discover' || page === 'saved'}
				<section class="page-heading" in:revealMotion|global={{ y: 16, duration: 450 }}>
					<div>
						<h1>
							<span class="desktop-title"
								>{page === 'saved' ? 'Your recipe collection' : 'Discover recipes'}</span
							><span class="mobile-title">{page === 'saved' ? 'Saved recipes' : 'Recipes'}</span
							><span class="heading-spark" aria-hidden="true">✴</span>
						</h1>
					</div>
					<button
						class="text-button taste-note"
						aria-label="Recipe preferences"
						onclick={openOnboarding}
						><span class="preference-label">Preferences</span><SlidersHorizontal
							size={18}
						/></button
					>
				</section>
				{#if page === 'discover'}<div class="mobile-pantry-actions">
						<button class="secondary" type="button" onclick={() => (modal = 'pantry')}
							><Plus size={18} />Ingredients</button
						>
						<button
							class="secondary"
							type="button"
							aria-label="Scan ingredients from a photo"
							aria-busy={scanBusy}
							disabled={scanBusy || busy || voiceBusy}
							onclick={() => imageInput.click()}><Camera size={19} /></button
						>
						<button
							class="secondary"
							type="button"
							aria-label="Dictate ingredients"
							disabled={busy || voiceBusy}
							onclick={dictate}><Mic size={19} /></button
						>
					</div>{/if}
				{#if page === 'discover'}<section
						class="inspiration-banner"
						in:revealMotion|global={{ y: 20, delay: 100, duration: 500 }}
					>
						<div class="banner-copy">
							<h2>What’s in your kitchen?</h2>
							<p>Add ingredients to inspire your recipes.</p>
							<div class="banner-actions">
								<button class="cream-button" type="button" onclick={() => (modal = 'pantry')}
									><Plus size={17} /> Add your ingredients <ArrowRight size={17} /></button
								><button
									class="banner-icon"
									type="button"
									aria-label="Scan ingredients from a photo"
									aria-busy={scanBusy}
									disabled={scanBusy || busy || voiceBusy}
									onclick={() => imageInput.click()}><Camera size={20} /></button
								><button
									class="banner-icon"
									type="button"
									aria-label="Dictate ingredients"
									disabled={busy || voiceBusy}
									onclick={dictate}><Mic size={20} /></button
								>
							</div>
						</div>
						<div class="banner-visual">
							<img
								src="https://images.unsplash.com/photo-1540420773420-3366772f4999?auto=format&fit=crop&w=800&q=85"
								alt="A colorful bowl of fresh vegetables and greens"
							/><span class="visual-spark">✳</span>
						</div>
					</section>
					{#if scanBusy}<div class="scan-status" role="status" aria-live="polite" in:revealMotion>
							<span><RefreshCw size={17} class="scan-spin" />Scanning photo for ingredients…</span>
							<button class="secondary" type="button" onclick={() => cancelScan()}>Cancel</button>
						</div>{/if}{/if}
				<section class="recipe-section">
					<div class="section-heading">
						<div>
							<h2>
								{page === 'saved' ? 'Saved recipes' : 'Recipe ideas'}<span
									class="small-spark"
									aria-hidden="true">✷</span
								>
							</h2>
						</div>
						<div class="recipe-actions">
							<button class="secondary" onclick={openNewRecipe}><Plus size={17} />New recipe</button
							>
							<button class="secondary" onclick={() => openImport()}
								><Plus size={17} />Import</button
							>
							<button
								class="primary"
								onclick={() => {
									modal = 'generate';
									error = '';
								}}><Sparkles size={17} /> Generate</button
							>
						</div>
					</div>
					<div class="recipe-toolbar">
						<div
							class="filter-tabs-scroll"
							class:can-scroll-left={filterOverflow.left}
							class:can-scroll-right={filterOverflow.right}
						>
							<div
								class="filter-tabs"
								role="group"
								aria-label="Filter recipes"
								bind:this={filterTabs}
								onscroll={syncFilterOverflow}
							>
								{#each ['For you', PANTRY_FILTER, 'Quick & easy', 'Plant-powered', 'Comfort food', 'High protein'] as item}<ToggleButton
										data-filter={item}
										class={{ active: filter === item }}
										pressed={filter === item}
										onclick={() => {
											lastActivePill = 'filter';
											priorityPantryIds = [];
											filter = item;
										}}
										>{#if item === 'For you'}<Sparkles
												size={14}
												aria-hidden="true"
											/>{:else if item === PANTRY_FILTER}<Carrot
												size={14}
												aria-hidden="true"
											/>{/if}{item}</ToggleButton
									>{/each}
								<ToggleButton
									data-filter="hidden"
									class={{ active: showHiddenRecipes }}
									pressed={showHiddenRecipes}
									onclick={() => {
										lastActivePill = 'hidden';
										showHiddenRecipes = !showHiddenRecipes;
									}}>Hidden recipes</ToggleButton
								>
							</div>
						</div>
						<div class="search-box" class:has-clear={query.length > 0}>
							<Search size={17} aria-hidden="true" /><input
								type="search"
								aria-label="Search recipes"
								placeholder="Search recipes"
								bind:value={query}
							/>{#if query}<button
									type="button"
									class="search-clear"
									aria-label="Clear search"
									onclick={() => (query = '')}><X size={16} aria-hidden="true" /></button
								>{/if}
						</div>
					</div>
					{#if filter === PANTRY_FILTER}
						<div class="discover-pantry-bar">
							<span>
								{#if activePriorityPantry.length}
									Prioritizing expiring ingredients: <b
										>{activePriorityPantry.map((item) => item.name).join(', ')}</b
									>
								{:else}
									Showing local recipes matching your stocked pantry ingredients.
								{/if}
							</span>
							<div class="discover-pantry-actions">
								{#if activePriorityPantry.length}<button
										class="text-button"
										onclick={() => (priorityPantryIds = [])}>All pantry matches</button
									>{/if}
								<button
									class="secondary"
									onclick={() => {
										modal = 'generate';
										error = '';
									}}><Sparkles size={16} /> Generate with AI</button
								>
							</div>
						</div>
					{/if}
					<div class="recipe-grid">
						{#each recipes as recipe, i (recipe.id)}<article
								class="recipe-card"
								animate:flip={{ duration: motionDuration(250) }}
								in:revealMotion|global={{ y: 20, duration: 400, delay: Math.min(i * 65, 350) }}
							>
								<div class="recipe-image">
									<button
										class="image-open"
										onclick={() => {
											selectedMealServings = undefined;
											selected = recipe;
										}}
										aria-label={`Open ${recipe.title}`}
										><img
											src={recipe.image || recipePlaceholder(recipe)}
											onerror={(event) => recipeImageError(event, recipe)}
											alt={recipe.title}
											loading={i > 2 ? 'lazy' : 'eager'}
										/></button
									><button
										class:saved={recipe.saved}
										class="save-recipe"
										onclick={() => saveRecipe(recipe)}
										aria-label={recipe.saved ? 'Unsave recipe' : 'Save recipe'}
										><Bookmark size={18} fill={recipe.saved ? 'currentColor' : 'none'} /></button
									>
								</div>
								<div class="recipe-info">
									<div class="recipe-kicker">
										{recipe.cuisine}<span>
											{recipe.rating ? `★ ${recipe.rating.toFixed(1)}` : ''}</span
										>
									</div>
									<button
										class="recipe-title"
										onclick={() => {
											selectedMealServings = undefined;
											selected = recipe;
										}}>{recipe.title}<ArrowUpRight size={18} /></button
									>
									<p>{recipe.description}</p>
									{#if recipe.hidden || recipe.tags.length}<ul class="recipe-tags">
											{#if recipe.hidden}<li class="recipe-badge">Hidden</li>{/if}
											{#each recipe.tags as tag}<li class="recipe-badge">{tag}</li>{/each}
										</ul>{/if}
									<div class="recipe-meta">
										<span><Clock size={14} />{recipe.time} min</span>{#if recipe.difficulty}<span
												><ChefHat size={14} />{recipe.difficulty}</span
											>{/if}<span class="pantry-match"
											><Leaf size={13} />{recipe.ingredients.filter((i) =>
												availablePantryNames.has(normalizeName(i.name))
											).length} in your pantry</span
										>
									</div>
								</div>
							</article>{/each}
					</div>
					{#if !recipes.length}{#if page === 'saved' && !kitchen.recipes.some((r) => r.saved && !r.hidden)}<div
								class="empty-state"
							>
								<Heart size={36} />
								<h2>No saved recipes yet</h2>
								<p>Tap the bookmark on any recipe to keep it close, or add your own.</p>
								<button type="button" class="secondary" onclick={openNewRecipe}
									><Plus size={17} />New recipe</button
								>
							</div>{:else if activeRecipeFilters}<div class="empty-state filtered-recipe-empty">
								<Heart size={36} />
								<h2>
									{page === 'saved' ? 'No matching saved recipes' : 'No matching recipes'}
								</h2>
								<p>
									{page === 'saved'
										? 'Your current search or filters hid your saved recipes.'
										: filter === PANTRY_FILTER
											? 'No local recipes match those pantry ingredients yet. Reset filters or generate with AI.'
											: 'No recipes match your current search or filters.'}
								</p>
								<button type="button" class="secondary" onclick={resetRecipeFilters}
									>Reset filters</button
								>
							</div>{:else}<div class="empty-state">
								<Heart size={36} />
								<h2>No recipes found</h2>
								<p>Add a new recipe, import a link, or generate ideas to get started.</p>
								<button type="button" class="secondary" onclick={openNewRecipe}
									><Plus size={17} />New recipe</button
								>
							</div>{/if}{/if}{#if capabilities.recipeSearch}<button
							class="browse-link"
							onclick={() => {
								modal = 'search';
								error = '';
							}}>Find recipes online <ArrowUpRight size={16} /></button
						>{/if}
				</section>
			{:else if page === 'pantry'}
				<section class="page-heading" in:revealMotion|global={{ y: 12, duration: 300 }}>
					<div>
						<h1>Your pantry<span class="heading-spark" aria-hidden="true">✳</span></h1>
						<p>Track ingredients and quantities you have on hand.</p>
					</div>
					<button class="primary" onclick={() => (modal = 'pantry')}
						><Plus size={18} /> Add ingredients</button
					>
				</section>
				<div class="pantry-summary">
					<span class="pantry-summary-meta"
						><span><b>{kitchen.pantry.length}</b> ingredients</span
						>{#if kitchen.pantry.some((item) => Number.isFinite(item.quantity) && item.quantity <= 0)}<span
								class="depleted-actions"
								><button class="text-button restock-depleted" onclick={() => restockPantryItems()}
									><ShoppingBasket size={16} />Restock depleted items</button
								><button
									class="text-button"
									onclick={() => {
										commitInlineEdits();
										kitchen.pantry = kitchen.pantry.filter(
											(item) => !(Number.isFinite(item.quantity) && item.quantity <= 0)
										);
										hasSampleRecords = hasSampleData(kitchen);
									}}>Clear depleted items</button
								></span
							>{/if}{#if hasSampleRecords}<button class="text-button" onclick={freshKitchen}
								>Clear sample data</button
							>{/if}</span
					>
					<div>
						<button
							class="secondary"
							type="button"
							aria-busy={scanBusy}
							disabled={scanBusy || busy || voiceBusy}
							onclick={() => imageInput.click()}
							><Camera size={17} /> {scanBusy ? 'Scanning photo…' : 'Scan a photo'}</button
						><button class="secondary" type="button" disabled={busy || voiceBusy} onclick={dictate}
							><Mic size={17} /> Tell us what you have</button
						>
					</div>
				</div>
				{#if scanBusy}<div class="scan-status" role="status" aria-live="polite" in:revealMotion>
						<span><RefreshCw size={17} class="scan-spin" />Scanning photo for ingredients…</span>
						<button class="secondary" type="button" onclick={() => cancelScan()}>Cancel</button>
					</div>{/if}
				<div class="pantry-controls">
					<div class="pantry-filter-bar">
						<label class="search-box pantry-search">
							<Search size={17} aria-hidden="true" /><span class="visually-hidden"
								>Search pantry</span
							><input type="search" placeholder="Search pantry" bind:value={pantryQuery} />
						</label>
						<div class="expiry-filters" role="group" aria-label="Filter pantry by expiry">
							{#each [{ id: 'all', label: 'All ingredients', count: kitchen.pantry.length }, { id: 'soon', label: 'Expiring soon', count: kitchen.pantry.filter((item) => item.quantity > 0 && expiryStatus(item.expires) === 'soon').length }, { id: 'expired', label: 'Expired', count: kitchen.pantry.filter((item) => expiryStatus(item.expires) === 'expired').length }] as option}<ToggleButton
									class={{ active: pantryFilter === option.id }}
									pressed={pantryFilter === option.id}
									onclick={() => (pantryFilter = option.id)}
									><span>{option.label}</span><span class="visually-hidden">{', '}</span><span
										class="expiry-count"
										>{option.count}<span class="visually-hidden"
											>{` ${option.count === 1 ? 'item' : 'items'}`}</span
										></span
									></ToggleButton
								>{/each}
						</div>
					</div>
					{#if pantryCategories.length}<div
							class="filter-tabs pantry-categories"
							role="group"
							aria-label="Filter pantry by category"
						>
							<ToggleButton
								class={{ active: pantryCategory === 'all' }}
								pressed={pantryCategory === 'all'}
								onclick={() => (pantryCategory = 'all')}>All categories</ToggleButton
							>{#each pantryCategories as category (category.key)}<ToggleButton
									class={{ active: pantryCategory.toLowerCase() === category.key }}
									pressed={pantryCategory.toLowerCase() === category.key}
									onclick={() =>
										(pantryCategory =
											pantryCategory.toLowerCase() === category.key ? 'all' : category.label)}
									>{category.label}</ToggleButton
								>{/each}
						</div>{/if}
				</div>
				<div class="pantry-table">
					{#if pantryDraft}<datalist id="pantry-category-suggestions">
							{#each pantryCategorySuggestions as suggestion}<option value={suggestion}
								></option>{/each}
						</datalist>{/if}
					{#if visiblePantry.length}<div class="table-head" aria-hidden="true">
							<span>INGREDIENT</span><span>AMOUNT</span><span>BEST BEFORE</span><span></span>
						</div>
						<div class="pantry-list" role="list" aria-label="Pantry ingredients">
							{#each visiblePantry as item (item.id)}{@const expiry = expiryStatus(
									item.expires
								)}{@const itemDomId = encodeURIComponent(item.id)}{@const depleted =
									Number.isFinite(item.quantity) && item.quantity <= 0}
								<div
									class="pantry-row"
									class:editing={pantryDraft?.id === item.id}
									role="listitem"
									animate:flip={{ duration: motionDuration(200) }}
									in:revealMotion|global={{ y: 8, duration: 200 }}
									out:fadeMotion={{ duration: 120 }}
								>
									{#if pantryDraft?.id === item.id}<form
											class="pantry-edit-form"
											novalidate
											onsubmit={(event) => {
												event.preventDefault();
												void savePantryEdit();
											}}
										>
											<div class="pantry-edit-header">
												<span class="pantry-ingredient">
													<span class="ingredient-symbol" aria-hidden="true"
														>{ingredientEmoji(item.name)}</span
													><span class="ingredient-title-line"
														><b id={`pantry-item-${itemDomId}`} class="pantry-name">{item.name}</b
														>{#if item.sample}<small class="sample-badge">Sample</small>{/if}</span
													>
												</span>
												<div class="pantry-edit-actions">
													<button type="submit" class="primary pantry-done-button">Done</button
													><button
														type="button"
														class="secondary pantry-cancel-button"
														onclick={() => cancelPantryEdit()}>Cancel</button
													><button
														type="button"
														class="icon-button pantry-remove-button"
														aria-label={`Remove ${item.name}`}
														onclick={() => removePantryItem(item)}
														><X size={16} aria-hidden="true" /></button
													>
												</div>
											</div>
											<div
												class="pantry-edit-fields"
												role="group"
												aria-labelledby={`pantry-item-${itemDomId}`}
											>
												<div class="pantry-field">
													<label class="pantry-field-label" for={`pantry-amount-${itemDomId}`}
														><span>Amount</span><span class="visually-hidden"
															>{` of ${item.name}`}</span
														></label
													><input
														id={`pantry-amount-${itemDomId}`}
														type="number"
														min="0"
														max="1000000"
														step="any"
														bind:value={pantryDraft.quantity}
														onkeydown={handlePantryInputKeydown}
													/>
												</div>
												<div class="pantry-field">
													<label class="pantry-field-label" for={`pantry-unit-${itemDomId}`}
														><span>Unit</span><span class="visually-hidden"
															>{` for ${item.name}`}</span
														></label
													><input
														id={`pantry-unit-${itemDomId}`}
														type="text"
														maxlength="40"
														bind:value={pantryDraft.unit}
														onkeydown={handlePantryInputKeydown}
													/>
												</div>
												<div class="pantry-field">
													<label class="pantry-field-label" for={`pantry-category-${itemDomId}`}
														><span>Category</span><span class="visually-hidden"
															>{` for ${item.name}`}</span
														></label
													><input
														id={`pantry-category-${itemDomId}`}
														type="text"
														maxlength="100"
														list="pantry-category-suggestions"
														bind:value={pantryDraft.category}
														onkeydown={handlePantryInputKeydown}
													/>
												</div>
												<div class="pantry-field">
													<label class="pantry-field-label" for={`pantry-expiry-${itemDomId}`}
														><span>Best before</span><span class="visually-hidden"
															>{` for ${item.name}`}</span
														></label
													><input
														id={`pantry-expiry-${itemDomId}`}
														type="date"
														bind:value={pantryDraft.expires}
														onkeydown={handlePantryInputKeydown}
													/>
												</div>
											</div>
										</form>{:else}<span class="pantry-ingredient">
											<span class="ingredient-symbol" aria-hidden="true"
												>{ingredientEmoji(item.name)}</span
											><span class="ingredient-meta"
												><span class="ingredient-title-line"
													><b id={`pantry-item-${itemDomId}`} class="pantry-name">{item.name}</b
													>{#if item.sample}<small class="sample-badge">Sample</small>{/if}</span
												><span class="ingredient-tags"
													><span class="category-badge">{item.category.trim() || 'Pantry'}</span
													>{#if depleted}<button
															type="button"
															class="text-button restock-item"
															aria-label={`Restock ${item.name}`}
															onclick={() => restockPantryItems([item.id])}
															><ShoppingBasket size={14} />Restock</button
														>{:else if expiry === 'soon' && item.quantity > 0}<button
															type="button"
															class="text-button use-first"
															onclick={() => useFirstIngredients([item])}
															><Sparkles size={14} aria-hidden="true" />Use first</button
														>{/if}</span
												></span
											>
										</span><span class="pantry-amount"
											>{item.quantity}{item.unit ? ` ${item.unit}` : ''}</span
										><span class="pantry-expiry"
											><small
												class="expiry-badge"
												class:depleted
												class:expired={!depleted && expiry === 'expired'}
												class:soon={!depleted && expiry === 'soon'}
												>{depleted ? 'Depleted' : expiryBadgeLabel(expiry)}</small
											>{#if item.expires}<small class="pantry-date">{item.expires}</small
												>{/if}</span
										>
										<div
											class="pantry-row-actions"
											role="group"
											aria-labelledby={`pantry-item-${itemDomId}`}
										>
											<button
												type="button"
												class="text-button pantry-edit-button"
												data-pantry-edit={item.id}
												aria-label={`Edit ${item.name}`}
												onclick={() => startPantryEdit(item)}>Edit</button
											><button
												type="button"
												class="icon-button pantry-remove-button"
												aria-label={`Remove ${item.name}`}
												onclick={() => removePantryItem(item)}
												><X size={16} aria-hidden="true" /></button
											>
										</div>{/if}
								</div>{/each}
						</div>{/if}
				</div>
				{#if !kitchen.pantry.length}<div class="empty-state">
						<Carrot size={40} />
						<h2>No ingredients yet</h2>
						<p>Add a few things from your fridge to get started.</p>
					</div>{:else if !visiblePantry.length}<div class="empty-state filtered-pantry-empty">
						<Carrot size={34} />
						<h2>No matching ingredients</h2>
						<p>Try another search, category, or expiry filter.</p>
						<button type="button" class="secondary" onclick={resetPantryFilters}
							>Reset filters</button
						>
					</div>{/if}
				<div class="pantry-footer">
					<button class="primary" onclick={cookFromPantry}
						><Sparkles size={17} /> Cook from my pantry</button
					>
				</div>
			{:else if page === 'planner'}
				{@const todayKey = dateKey(new Date())}
				<section class="page-heading" in:revealMotion|global={{ y: 12, duration: 300 }}>
					<div>
						<h1>Meal planner<span class="heading-spark" aria-hidden="true">✷</span></h1>
						<p>Schedule meals and build your weekly shopping list.</p>
					</div>
					<button class="primary" onclick={() => openRecipePicker()}
						><Plus size={17} /> Plan a meal</button
					>
				</section>
				<div class="calendar-toolbar">
					<div>
						<button class="icon-button" onclick={() => weekOffset--} aria-label="Previous week"
							><ChevronLeft size={20} /></button
						>
						<h2>
							{week[0].toLocaleDateString('en', { month: 'long', day: 'numeric' })} – {week[6].toLocaleDateString(
								'en',
								{
									month: week[0].getMonth() !== week[6].getMonth() ? 'short' : undefined,
									day: 'numeric'
								}
							)}
						</h2>
						<button class="icon-button" onclick={() => weekOffset++} aria-label="Next week"
							><ChevronRight size={20} /></button
						><button class="text-button" onclick={showCurrentWeek}>This week</button>
					</div>
					<button
						class="secondary"
						onclick={() => {
							const meals = kitchen.meals.filter(
								(m) => !m.completedAt && week.some((d) => dateKey(d) === m.date)
							);
							if (!meals.length) {
								notify('Plan a meal first to build your weekly shopping list.');
								return;
							}
							shoppingFor(
								kitchen.recipes.filter((r) => meals.some((m) => m.recipeId === r.id)),
								meals,
								`week:${dateKey(week[0])}`
							);
						}}><ShoppingBasket size={17} /> Shop this week</button
					>
				</div>
				{#key weekOffset}<div
						bind:this={calendarGrid}
						class="calendar-grid"
						in:revealMotion|global={{ y: 8, duration: 220 }}
					>
						{#each week as day}{@const dayKey = dateKey(day)}
							<div data-date={dayKey} class:today={dayKey === todayKey} class="calendar-day">
								<div class="day-heading">
									<span>{weekdayFormatter.format(day)}</span><b>{day.getDate()}</b>
								</div>
								{#each MEAL_SLOTS as slot}<div class="meal-slot">
										<span class="meal-label">{slot}</span
										>{#each mealsByDateSlot.get(mealSlotKey(dayKey, slot)) ?? [] as meal}{@const recipe =
												recipesById.get(meal.recipeId)}{#if recipe}<div class="calendar-meal">
													<button
														class="meal-open"
														onclick={() => {
															selectedMealServings = meal.servings;
															selected = recipe;
														}}
														>{#if !mobileCalendar}<img
																src={recipe.image || recipePlaceholder(recipe)}
																onerror={(event) => recipeImageError(event, recipe)}
																alt=""
																width="180"
																height="65"
																loading="lazy"
																decoding="async"
															/>{/if}<b>{recipe.title}</b><small
															>{recipe.time} min · {meal.servings} servings</small
														></button
													>
													<div class="calendar-meal-actions">
														{#if meal.completedAt}{@const cookedDate = formatCompletedDate(
																meal.completedAt,
																cookedBadgeFormatter,
																''
															)}<small class="cooked-badge"
																>{cookedDate ? `Cooked ${cookedDate}` : 'Cooked'}</small
															>{:else}<button
																class="text-button"
																onclick={() => editPlannedMeal(meal)}>Edit</button
															><button class="text-button" onclick={() => openCookDialog(meal)}
																>Cooked</button
															>{/if}
														<button
															class="remove-meal"
															aria-label="Remove planned meal"
															onclick={() => removePlannedMeal(meal)}><X size={13} /></button
														>
													</div>
												</div>{/if}{/each}<button
											class="add-meal"
											onclick={() => openRecipePicker({ date: dayKey, slot })}
											aria-label={`Plan ${slot} for ${day.toDateString()}`}
											><Plus size={17} /></button
										>
									</div>{/each}
							</div>{/each}
					</div>{/key}
				<section class="cooked-history">
					<div class="section-line">
						<h2>Cooked history</h2>
						<span class="muted">{completedMeals.length} meals</span>
					</div>
					{#if renderableCompletedMeals.length}<div class="cooked-history-list">
							{#each visibleCompletedMeals as meal (meal.id)}{@const recipe = recipesById.get(
									meal.recipeId
								)}{#if recipe}<article class="cooked-history-row">
										<img
											src={recipe.image || recipePlaceholder(recipe)}
											onerror={(event) => recipeImageError(event, recipe)}
											alt=""
											width="54"
											height="48"
											loading="lazy"
											decoding="async"
										/>
										<div>
											<b>{recipe.title}</b><span
												>{formatCompletedDate(meal.completedAt, historyDateFormatter)} · {meal.servings}
												servings{meal.leftoverServings
													? ` · ${meal.leftoverServings} leftover`
													: ''}</span
											>
										</div>
										<div class="cooked-history-actions">
											{#if meal.leftoverServings}<button
													class="text-button"
													aria-label={`Use 1 leftover of ${recipe.title}`}
													onclick={() => consumeLeftoverServing(meal)}>Use 1 leftover</button
												><button
													class="text-button"
													aria-label={`Clear leftovers for ${recipe.title}`}
													onclick={() => clearMealLeftovers(meal)}
													>Clear leftovers <Check size={15} /></button
												>{/if}<button
												class="text-button"
												onclick={() => {
													selectedMealServings = undefined;
													selected = recipe;
												}}
												>{recipe.rating ? 'View rating' : 'Rate recipe'} <Star size={15} /></button
											>
										</div>
									</article>{/if}{/each}
						</div>
						{#if renderableCompletedMeals.length > cookedHistoryLimit}<button
								type="button"
								class="secondary history-more"
								onclick={() => (cookedHistoryLimit += COOKED_HISTORY_PAGE_SIZE)}>Show more</button
							>{/if}{:else}<p class="muted history-empty">
							Meals marked cooked will appear here. You can add leftovers and update pantry stock
							when you finish a meal.
						</p>{/if}
				</section>
			{:else if page === 'shopping'}
				<section class="page-heading" in:revealMotion|global={{ y: 12, duration: 300 }}>
					<div>
						<h1>Shopping list<span class="heading-spark" aria-hidden="true">✴</span></h1>
						<p>
							Generated rows show their recipe or meal-plan source. Editing a row keeps your changes
							visible until that source is refreshed.
						</p>
					</div>
					<button class="secondary" disabled={!kitchen.shopping.length} onclick={exportList}
						><Share2 size={17} /> Share list</button
					>
				</section>
				<div class="shopping-layout">
					<div>
						<div class="section-line">
							<h2>Items to buy</h2>
							<span class="muted">{checkedCount} of {kitchen.shopping.length} purchased</span>
						</div>
						<div
							class="shopping-progress"
							role="progressbar"
							aria-label="Shopping progress"
							aria-valuemin={0}
							aria-valuemax={kitchen.shopping.length}
							aria-valuenow={checkedCount}
						>
							<span
								style={`width:${kitchen.shopping.length ? (checkedCount / kitchen.shopping.length) * 100 : 0}%`}
							></span>
						</div>
						<div class="shopping-filters" role="group" aria-label="Filter shopping list">
							{#each [{ id: 'all' as const, label: 'Show all', count: kitchen.shopping.length }, { id: 'unpurchased' as const, label: 'Hide purchased', count: checkedCount }] as option}<button
									type="button"
									class:active={shoppingFilter === option.id}
									aria-pressed={shoppingFilter === option.id}
									onclick={() => {
										if (option.id === 'unpurchased' && editingShoppingId) {
											const active = kitchen.shopping.find(
												(entry) => entry.id === editingShoppingId
											);
											if (active?.checked) {
												applyShoppingEdit(active);
												clearEditingShoppingState();
											}
										}
										shoppingFilter = option.id;
									}}>{option.label}<span>{option.count}</span></button
								>{/each}
						</div>
						{#if voiceTarget === 'shopping' && !modal && (voiceBusy || voiceRetained)}{@render voiceSession()}{/if}
						<form
							class="inline-add"
							onsubmit={(e) => {
								e.preventDefault();
								addShoppingQuickItem();
							}}
						>
							<Plus size={18} /><input
								aria-label="Add shopping item"
								placeholder="Anything else for the basket?"
								maxlength="2000"
								bind:value={shoppingText}
								oninput={() => {
									if (!shoppingText.trim()) shoppingVoiceInput = false;
								}}
							/><button
								bind:this={shoppingMicButton}
								type="button"
								class="icon-button"
								aria-label="Dictate shopping items"
								aria-disabled={voiceBusy || undefined}
								onclick={dictateShopping}><Mic size={18} /></button
							><button type="submit" class="text-button">Add</button>
						</form>
						{#each visibleShopping as item (item.id)}<div
								class:checked={item.checked}
								class="shopping-row"
								animate:flip={{ duration: motionDuration(200) }}
								in:revealMotion|global={{ y: 8, duration: 200 }}
								out:fadeMotion={{ duration: 120 }}
							>
								<button
									type="button"
									role="checkbox"
									aria-checked={item.checked}
									class="check-box"
									class:checked={item.checked}
									aria-label={`Mark ${item.name} ${item.checked ? 'needed' : 'purchased'}`}
									onclick={() => {
										item.checked = !item.checked;
										if (
											shoppingFilter === 'unpurchased' &&
											item.checked &&
											editingShoppingId === item.id
										) {
											applyShoppingEdit(item);
											clearEditingShoppingState();
										}
									}}
									>{#if item.checked}<Check size={16} />{/if}</button
								>
								{#if editingShoppingId === item.id && editingShoppingDraft?.id === item.id}<form
										class="shopping-edit-form"
										novalidate
										onsubmit={(e) => {
											e.preventDefault();
											void finishEditingShoppingItem(item);
										}}
									>
										<div class="shopping-item-edit">
											<input
												class="shopping-name"
												data-shopping-name={item.id}
												aria-label="Shopping item name"
												bind:value={editingShoppingDraft.name}
												maxlength="200"
												onblur={() => {
													if (editingShoppingId === item.id) applyShoppingEdit(item);
												}}
											/><small class="shopping-source">{shoppingSourceLabel(item.sourceKey)}</small>
										</div>
										<span class="shopping-quantity"
											><input
												aria-label={`Quantity of ${item.name}`}
												type="number"
												min="0.01"
												max="1000000"
												step="0.01"
												bind:value={editingShoppingDraft.quantity}
												onblur={() => {
													if (editingShoppingId === item.id) applyShoppingEdit(item);
												}}
											/><input
												aria-label={`Unit for ${item.name}`}
												bind:value={editingShoppingDraft.unit}
												maxlength="40"
												onblur={() => {
													if (editingShoppingId === item.id) applyShoppingEdit(item);
												}}
											/></span
										>
										<button type="submit" class="text-button">Done</button>
									</form>
								{:else}
									<div class="shopping-item-edit">
										<button
											type="button"
											tabindex="-1"
											class="shopping-name"
											onclick={() => (item.checked = !item.checked)}>{item.name}</button
										><small class="shopping-source">{shoppingSourceLabel(item.sourceKey)}</small>
									</div>
									<span class="shopping-quantity"
										>{item.quantity}
										{item.unit}<button
											type="button"
											class="text-button"
											data-shopping-edit={item.id}
											aria-label={`Edit ${item.name}`}
											onclick={() => void startEditingShoppingItem(item)}>Edit</button
										></span
									>
								{/if}
								<button
									type="button"
									class="icon-button"
									aria-label={`Remove ${item.name}`}
									onclick={() => removeShoppingItem(item)}><X size={15} /></button
								>
							</div>{/each}{#if !kitchen.shopping.length}<div class="empty-state">
								<ShoppingBasket size={40} />
								<h3>Your shopping list is empty</h3>
								<p>Add a recipe or shop your meal plan to make a list.</p>
								<button class="secondary" onclick={() => navigate('discover')}
									>Browse recipes <ArrowRight size={16} /></button
								>
							</div>{:else if !visibleShopping.length}<div class="shopping-complete">
								<p>
									<Check size={16} />All {checkedCount}
									{checkedCount === 1 ? 'item' : 'items'} purchased.
								</p>
								<button class="text-button" onclick={movePurchasedToPantry}
									>Put purchased items in my pantry <ArrowRight size={16} /></button
								>
							</div>{/if}
						{#if !kitchen.shopping.length || visibleShopping.length}<button
								class="text-button shopping-transfer"
								onclick={movePurchasedToPantry}
								>Put purchased items in my pantry <ArrowRight size={16} /></button
							>{/if}
					</div>
				</div>
			{/if}
		</div>
	</main>
</div>
<div class="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
	{scanBusy ? 'Scanning photo for ingredients…' : toast}
</div>
{#if toast}<div class="toast" transition:revealMotion|global={{ y: 25, duration: 250 }}>
		<span>✳</span>{toast}{#if toastUndo}<button class="toast-undo" onclick={toastUndo}
				>{toastActionLabel}</button
			>{/if}<button
			onclick={() => {
				toast = '';
				toastUndo = null;
				toastActionLabel = 'Undo';
			}}
			aria-label="Dismiss notification"><X size={16} /></button
		>
	</div>{/if}
{#if selected && !modal}<RecipeDetail
		recipe={selected}
		initialServings={selectedMealServings ?? selected.servings}
		bind:completedSteps={
			() => cookingSteps[cookingSessionKey] ?? [],
			(steps) => {
				cookingSteps[cookingSessionKey] = steps;
			}
		}
		close={closeRecipeDetail}
		save={() => saveRecipe(selected!)}
		shop={(servings) =>
			shoppingFor(
				[selected!],
				[{ id: crypto.randomUUID(), recipeId: selected!.id, date: '', slot: '', servings }],
				`recipe:${selected!.id}`
			)}
		plan={(servings) => planRecipe(selected!, servings)}
		nutrition={refreshNutrition}
		edit={() => editSavedRecipe(selected!)}
		remove={() => askDeleteRecipe(selected!)}
		toggleHidden={() => toggleRecipeHidden(selected!)}
		{busy}
		rate={(n) => {
			kitchen.preferences.ratings = applyRecipeRating(selected!, kitchen.preferences.ratings, n);
			const stored = kitchen.recipes.find((item) => item.id === selected!.id);
			if (stored && stored !== selected!) {
				applyRecipeRating(stored, undefined, n);
			}
			kitchen.recipes = [...kitchen.recipes];
			notify(
				n === undefined ? 'Rating cleared.' : 'Rating saved. Future recipes will use your feedback.'
			);
		}}
	/>{/if}
{#if editingRecipe}{#key editingRecipe.id}<RecipeEditor
			bind:this={recipeEditor}
			recipe={editingRecipe}
			mode={editingRecipeMode}
			canUploadCover={Boolean(user) && online}
			cancel={closeRecipeEditor}
			save={saveEditedRecipe}
		/>{/key}{/if}
{#if modal}<ModalDialog
		viewKey={modal}
		dialogClass={[
			'flavor-dialog',
			modal === 'onboarding' && 'onboarding-dialog',
			(modal === 'settings' ||
				modal === 'pickRecipe' ||
				modal === 'import' ||
				modal === 'editMeal' ||
				modal === 'cookMeal') &&
				'wide',
			modal === 'import' && 'capture-dialog'
		]
			.filter(Boolean)
			.join(' ')}
		labelledBy={modal === 'import' ? 'recipe-import-title' : undefined}
		label={dialogNames[modal] || 'Kitchen dialog'}
		onclose={closeDialog}
	>
		{#snippet header()}
			{#if modal === voiceTarget && (voiceTarget !== 'import' || !isReviewingImportDraft(importSession)) && (voiceBusy || voiceRetained)}{@render voiceSession()}{/if}
		{/snippet}
		{#if modal === 'import'}<RecipeImport
				bind:session={importSession}
				capture={captureImport}
				save={saveImportedRecipe}
				dictate={dictateRecipe}
				{voiceBusy}
			/>{:else if modal === 'onboarding'}
			<span class="dialog-spark">✷</span>
			<h2>Recipe preferences</h2>
			<p class="muted onboarding-intro">Optional. Change these preferences anytime in Settings.</p>
			<form onsubmit={finishOnboarding}>
				<fieldset class="quiz-group">
					<legend>Preferred cooking time</legend>
					<div class="quiz-options quiz-time">
						{#each [15, 30, 45, 60] as minutes}<label class="quiz-option"
								><input
									type="radio"
									name="cooking-time"
									value={minutes}
									bind:group={quizTime}
								/><span>{minutes} min</span></label
							>{/each}
					</div>
				</fieldset>
				<fieldset class="quiz-group">
					<legend>Favorite cuisines</legend>
					<p class="quiz-help">Choose any, or leave blank for all cuisines.</p>
					<div class="quiz-options quiz-cuisines">
						{#each cuisineChoices as cuisine}<label class="quiz-option"
								><input type="checkbox" value={cuisine} bind:group={quizCuisines} /><span
									>{cuisine}</span
								></label
							>{/each}
					</div>
				</fieldset>
				<fieldset class="quiz-group">
					<legend>Cooking complexity</legend>
					<div class="quiz-options quiz-complexity">
						{#each ['Easy', 'Moderate', 'Adventurous'] as complexity}<label class="quiz-option"
								><input
									type="radio"
									name="cooking-complexity"
									value={complexity}
									bind:group={quizComplexity}
								/><span>{complexity}</span></label
							>{/each}
					</div>
				</fieldset>
				<details class="quiz-dietary">
					<summary>Any dietary preferences or allergies? <span>Optional</span></summary>
					<label class="field"
						>Dietary style<select bind:value={quizDiet}
							><option value="none">No dietary restriction</option><option value="vegetarian"
								>Vegetarian</option
							><option value="vegan">Vegan</option><option value="pescatarian">Pescatarian</option
							><option value="gluten-free">Gluten-free</option><option value="dairy-free"
								>Dairy-free</option
							></select
						></label
					>
					<label class="field"
						>Allergies or ingredients to avoid<input
							bind:value={quizAllergies}
							maxlength="500"
							placeholder="e.g. peanuts, shellfish"
						/></label
					>
					<p class="field-help">
						These guide generation. Check ingredients and labels before cooking.
					</p>
				</details>
				<div class="dialog-actions quiz-actions">
					<button class="primary" type="submit">Save preferences <Check size={17} /></button><button
						class="text-button"
						type="button"
						onclick={dismissOnboarding}>Maybe later</button
					>
				</div>
			</form>
		{:else if modal === 'pantry'}<span class="dialog-spark">✳</span>
			<h2>Add ingredients</h2>
			{#if scanBusy}<div class="scan-status" role="status" aria-live="polite" in:revealMotion>
					<span><RefreshCw size={17} class="scan-spin" />Scanning photo for ingredients…</span>
					<button class="secondary" type="button" onclick={() => cancelScan()}>Cancel</button>
				</div>{/if}

			<label class="field"
				>Ingredients<textarea
					bind:value={pantryInput}
					maxlength="20000"
					placeholder={'Tomatoes, spinach, 200 g pasta, 2 eggs…'}
					rows="5"></textarea></label
			>
			<p class="field-help">
				Separate with commas or new lines. Add quantities and units when you know them.
			</p>
			<div class="dialog-actions">
				<button
					bind:this={pantryVoiceButton}
					class="secondary"
					type="button"
					disabled={voiceBusy || busy}
					onclick={dictate}><Mic size={17} /> Use voice</button
				><button
					class="secondary"
					type="button"
					aria-busy={scanBusy}
					onclick={() => imageInput.click()}
					disabled={scanBusy || busy || voiceBusy}
					><Camera size={17} /> {scanBusy ? 'Scanning…' : 'Use photo'}</button
				><button
					class="primary"
					type="button"
					disabled={voiceBusy || busy || !pantryInput.trim()}
					onclick={addIngredients}>Add ingredients <ArrowRight size={17} /></button
				>
			</div>
		{:else if modal === 'auth' && managedAuth}<span class="dialog-spark">✳</span>
			<h2>Managed by your organization</h2>
			<p class="muted">
				Your account and access are managed by your organization's identity provider.
			</p>
			{#if providerLoginUrl}<a class="primary full" href={providerLoginUrl}
					>Continue with organization sign-in <ArrowRight size={17} /></a
				>{:else}<p class="field-help">
					Sign in through your organization's access proxy, then reload Flavorithm.
				</p>{/if}
		{:else if modal === 'auth'}<span class="dialog-spark">✳</span>
			<h2>{authMode === 'register' ? 'Create an account' : 'Sign in'}</h2>
			<p class="muted">Sync your pantry, recipes, and household.</p>
			<form onsubmit={authenticate}>
				{#if authMode === 'register'}<label class="field"
						>Your name<input
							required
							minlength="2"
							maxlength="80"
							autocomplete="name"
							bind:value={name}
						/></label
					>{/if}<label class="field"
					>Email address<input
						type="email"
						required
						autocomplete="email"
						bind:value={email}
					/></label
				><label class="field"
					>Password<input
						type="password"
						required
						minlength="10"
						maxlength="128"
						autocomplete={authMode === 'register' ? 'new-password' : 'current-password'}
						bind:value={password}
					/></label
				>
				<p class="field-help">Use at least 10 characters.</p>
				{#if authMode === 'login' && capabilities.emailDelivery}<button
						type="button"
						class="text-button"
						onclick={() => {
							modal = 'recover';
							error = '';
						}}>Forgot your password?</button
					>{/if}{#if error}<p class="error" role="alert">{error}</p>{/if}<button
					class="primary full"
					disabled={busy}
					>{busy
						? 'Opening your kitchen…'
						: authMode === 'register'
							? 'Create account'
							: 'Sign in'}<ArrowRight size={17} /></button
				>
			</form>
			<button
				class="text-button full"
				onclick={() => {
					authMode = authMode === 'register' ? 'login' : 'register';
					error = '';
				}}
				>{authMode === 'register'
					? 'Already have a kitchen? Sign in'
					: 'New around here? Create an account'}</button
			>
		{:else if modal === 'generate'}<span class="dialog-spark">✴</span>
			<h2>Generate recipes</h2>
			<p class="muted">
				Uses your pantry and preferences. Recipes may include additional ingredients.
			</p>
			<label class="field"
				>What are you in the mood for?<textarea
					rows="3"
					bind:value={prompt}
					placeholder="e.g. a spicy vegetarian dinner in 30 minutes"></textarea></label
			>
			<div class="two-fields">
				<label class="field"
					>Time to cook<select bind:value={kitchen.preferences.maxTime}
						><option value={15}>15 minutes</option><option value={30}>30 minutes</option><option
							value={45}>45 minutes</option
						><option value={60}>An hour</option><option value={120}>A slow afternoon</option
						></select
					></label
				><label class="field"
					>Dietary style<select bind:value={kitchen.preferences.diet}
						><option value="none">A bit of everything</option><option>Vegetarian</option><option
							>Vegan</option
						><option>Pescatarian</option><option>Gluten-free</option><option>Low-carb</option
						></select
					></label
				>
			</div>
			<label class="field"
				>Allergies & ingredients to avoid<input
					bind:value={kitchen.preferences.allergies}
					maxlength="2000"
					placeholder="e.g. peanuts, shellfish"
				/></label
			>
			<p class="field-help">
				Check all ingredients and substitutions against your allergies before cooking.
			</p>
			{#if error}<p class="error" role="alert">{error}</p>{/if}<button
				class="primary full"
				disabled={busy}
				onclick={generate}
				><Sparkles size={18} />{busy ? 'Generating recipes…' : 'Generate recipes'}</button
			>
		{:else if modal === 'settings'}
			<h2>Settings</h2>
			<div class="settings-section">
				<h3>Appearance</h3>
				<div class="theme-grid" role="group" aria-label="Color theme">
					{#each themes as theme}<ToggleButton
							class={{ active: kitchen.preferences.theme === theme }}
							pressed={kitchen.preferences.theme === theme}
							onclick={() => (kitchen.preferences.theme = theme)}
							>{theme}{#if kitchen.preferences.theme === theme}<Check
									size={13}
									aria-hidden="true"
								/>{/if}</ToggleButton
						>{/each}
				</div>
				<ToggleButton
					class={{ secondary: true, active: kitchen.preferences.dark }}
					pressed={kitchen.preferences.dark}
					onclick={() => (kitchen.preferences.dark = !kitchen.preferences.dark)}
					>{#if kitchen.preferences.dark}<Sun size={16} aria-hidden="true" />{:else}<Moon
							size={16}
							aria-hidden="true"
						/>{/if}Dark appearance</ToggleButton
				>
			</div>

			<div class="settings-section">
				<h3>Recipe preferences</h3>
				<p class="muted">
					{kitchen.preferences.maxTime} minutes · {kitchen.preferences.complexity} · {kitchen.preferences.cuisines?.join(
						', '
					) || 'Open to every cuisine'}
				</p>
				<button class="secondary" onclick={openOnboarding}
					>Edit my taste preferences <SlidersHorizontal size={16} /></button
				>
			</div>
			{#if user}<div class="settings-section">
					<h3>{managedAuth ? 'Organization account' : 'Account email'}</h3>
					<p class="muted">
						{user.email}{managedAuth
							? ' · Managed by your identity provider'
							: ` · ${user.emailVerified ? 'Verified' : 'Not verified'}`}
					</p>
					{#if !managedAuth}
						{#if user.emailVerified}<p class="field-help">
								Email verification is optional for using your kitchen.
							</p>{:else}<button
								class="secondary"
								disabled={!capabilities.emailDelivery || verificationBusy}
								onclick={sendEmailVerification}
								>{verificationBusy ? 'Sending…' : 'Send / resend verification email'}</button
							>{#if !capabilities.emailDelivery}<p class="field-help">
									Email delivery is unavailable. Ask the server operator to configure email
									delivery.
								</p>{/if}{/if}
					{/if}
				</div>{/if}
			<div class="settings-section">
				<VoiceSettings
					bind:provider={voiceProvider}
					bind:model={voiceModel}
					bind:apiKey={voiceApiKey}
					localAvailable={localVoiceAvailable}
					userId={user?.id}
				/>
			</div>
			<div class="settings-section intelligence-settings">
				<AIConnection
					bind:preferences={kitchen.preferences}
					bind:apiKey
					{providers}
					{accountModels}
					{chatGPT}
					activeAccount={activeChatGPTAccount}
					signedIn={Boolean(user)}
					{managedAuth}
					busy={connectionBusy}
					loading={catalogLoading}
					{catalogError}
					authorizationUrl={chatGPTAuthorizationUrl}
					device={chatGPTDevice}
					oncancel={cancelChatGPTDevice}
					oncopycode={copyChatGPTDeviceCode}
					onselect={(id) => changeConnection(id)}
					onaccount={() => changeConnection()}
					onconnect={connectChatGPT}
					ondisconnect={disconnectChatGPT}
					onrefresh={refreshAISettings}
					onsignin={openAuthentication}
					onoverride={() => {
						void loadModelCatalog();
					}}
				/>
			</div>

			{#if hasSampleRecords}<div class="settings-section">
					<h3>Sample data</h3>
					<p class="muted">
						Remove untouched starter ingredients, planned meals, and saved recipe bookmarks while
						keeping everything you added or edited.
					</p>
					<div class="dialog-actions">
						<button class="secondary" onclick={freshKitchen}>Clear sample data</button>
					</div>
				</div>{/if}
			<div class="settings-section">
				<h3>Your data</h3>
				<p class="muted">
					{#if !user}
						Export the kitchen saved in this browser as JSON.
					{:else if managedAuth}
						Export your account and shared kitchen.
					{:else}
						Export your account and shared kitchen, or permanently remove your account.
					{/if}
				</p>
				<div class="dialog-actions">
					<button class="secondary" onclick={exportKitchen}
						><Download size={16} /> Export my data</button
					>{#if user && !managedAuth}<button
							class="text-button danger"
							onclick={() => {
								modal = 'delete';
								error = '';
							}}>Delete account</button
						>{/if}
				</div>
			</div>
			{#if error}<p class="error" role="alert">{error}</p>{/if}
			<div class="dialog-actions">
				{#if user && (!managedAuth || providerLogoutUrl)}<button
						class="text-button"
						onclick={logout}><LogOut size={16} /> Sign out</button
					>{:else if user && managedAuth}<span class="field-help"
						>Sign-out is managed by your access proxy.</span
					>{:else if !user && !managedAuth}<button class="text-button" onclick={openAuthentication}
						>Create an account</button
					>{:else if !user}<button class="text-button" onclick={openAuthentication}
						>Organization sign-in</button
					>{/if}{#if deferredInstall}<button
						class="secondary"
						onclick={() => deferredInstall.prompt()}>Install app</button
					>{/if}<button
					class="primary"
					onclick={() => {
						closeDialog();
						notify('Preferences saved.');
					}}>Done <Check size={17} /></button
				>
			</div>
		{:else if modal === 'household'}<span class="dialog-spark">✳</span>
			<h2>Your household</h2>
			<p class="muted">Shared pantry, recipes, meals, and shopping.</p>
			{#if householdBusy}<p class="field-help" role="status">Updating household…</p>{/if}
			<div class="household-members">
				{#each members as member (member.id)}<div class="member-row">
						<span class="profile-avatar">{member.name.trim().charAt(0).toUpperCase() || '•'}</span>
						<div class="member-copy">
							<b>{member.name}{member.id === user?.id ? ' · You' : ''}</b><span>{member.email}</span
							>
						</div>
						<span class="member-role" class:owner-role={member.role === 'owner'}
							>{member.role === 'owner' ? 'Owner' : 'Member'}</span
						>
						{#if canManageHousehold && member.role !== 'owner' && member.id !== user?.id}<button
								class="text-button danger member-remove"
								disabled={householdBusy}
								onclick={() => askRemoveMember(member)}>Remove</button
							>{/if}
					</div>{/each}
			</div>
			{#if canManageHousehold}<section class="household-invites">
					<h3>Invitations</h3>
					{#if householdInvites.length}<div class="invite-list">
							{#each householdInvites as invite (invite.inviteId)}<div class="invite-row">
									<span
										>Expires {new Date(invite.expiresAt).toLocaleDateString('en', {
											month: 'short',
											day: 'numeric'
										})}</span
									><button
										class="text-button danger"
										disabled={householdBusy}
										onclick={() => revokeInvite(invite.inviteId)}>Revoke</button
									>
								</div>{/each}
						</div>{:else}<p class="field-help">No active invitations.</p>{/if}
					<button class="primary full" disabled={householdBusy} onclick={invite}
						><Plus size={17} /> Create invitation</button
					>
					{#if inviteCode}<div class="invite-code">
							<code>{inviteCode}</code><button
								class="icon-button"
								aria-label="Copy invitation"
								onclick={() =>
									navigator.clipboard
										.writeText(inviteCode)
										.then(() => notify('Invite code copied.'))
										.catch(() => notify('Select and copy the code manually.'))}
								><Copy size={17} /></button
							>
						</div>
						<p class="field-help">Share privately. This code works once.</p>{/if}
				</section>{:else}<p class="field-help">
					Only the household owner can manage invitations or remove members.
				</p>{/if}
			<hr />
			<h3>Have an invitation?</h3>
			<label class="field"
				>Invite code<input
					bind:value={joinCode}
					placeholder="Paste invitation code"
					autocomplete="off"
				/></label
			>
			<button
				class="secondary full"
				disabled={householdBusy || !joinCode.trim()}
				onclick={() => join()}>Join household <ArrowRight size={17} /></button
			>
			{#if error}<p class="error" role="alert">{error}</p>{/if}
			{#if members.length > 1}
				<button
					class="text-button danger full"
					disabled={householdBusy}
					onclick={() => {
						modal = 'leave';
						error = '';
					}}>Leave this household</button
				>
			{:else if members.length === 1 || !householdBusy}
				<p class="field-help">
					You already have your own personal kitchen. Invite someone above to share it, or enter an
					invite code to join another household.
				</p>
			{/if}
		{:else if modal === 'confirmJoin'}
			<h2>Replace your personal kitchen?</h2>
			<p class="muted">
				Joining this household will replace your current personal kitchen, including any saved
				recipes, cover photos, pantry items, planned meals, and shopping list. Download a backup
				first if you want to keep a copy.
			</p>
			<button class="secondary full" disabled={householdBusy} onclick={exportKitchen}
				><Download size={17} /> Export backup</button
			>
			{#if error}<p class="error" role="alert">{error}</p>{/if}
			<div class="dialog-actions">
				<button
					class="secondary"
					disabled={householdBusy}
					onclick={() => {
						error = '';
						modal = 'household';
					}}>Cancel</button
				><button class="primary danger-action" disabled={householdBusy} onclick={() => join(true)}
					>{householdBusy ? 'Joining…' : 'Replace kitchen'}</button
				>
			</div>
		{:else if modal === 'removeMember'}
			<h2>Remove household member?</h2>
			<p class="muted">
				{memberToRemove?.name} will lose access to this shared kitchen. Their account will remain active.
			</p>
			{#if error}<p class="error" role="alert">{error}</p>{/if}
			<div class="dialog-actions">
				<button
					class="secondary"
					disabled={householdBusy}
					onclick={() => {
						memberToRemove = null;
						error = '';
						modal = 'household';
					}}>Keep member</button
				><button
					class="primary danger-action"
					disabled={householdBusy}
					onclick={confirmRemoveMember}>{householdBusy ? 'Removing…' : 'Remove member'}</button
				>
			</div>
		{:else if modal === 'leave'}
			{@const nextHouseholdOwner = canManageHousehold
				? members.find((member) => member.id !== user?.id)
				: undefined}
			<h2>Leave this household?</h2>
			<p class="muted">
				Leaving gives you a new personal kitchen. The shared pantry and recipes stay with your
				household. You can rejoin with a new invitation.
			</p>
			{#if nextHouseholdOwner}
				<p class="field-help">
					Ownership of this household will transfer to <b>{nextHouseholdOwner.name}</b>.
				</p>
			{/if}
			{#if error}<p class="error" role="alert">{error}</p>{/if}
			<div class="dialog-actions">
				<button
					class="secondary"
					disabled={busy || householdBusy}
					onclick={() => {
						error = '';
						modal = 'household';
					}}>Stay in household</button
				><button
					class="primary danger-action"
					disabled={busy || householdBusy}
					onclick={leaveHousehold}>{busy || householdBusy ? 'Leaving…' : 'Leave household'}</button
				>
			</div>
		{:else if modal === 'delete' && !managedAuth}
			<h2>Delete your account?</h2>
			<p class="muted">
				This permanently deletes your account, preferences, and sessions. Your shared kitchen
				remains for other members; a household with no members is deleted. This cannot be undone.
			</p>
			<form onsubmit={deleteAccount}>
				<label class="field"
					>Confirm with your password<input
						type="password"
						required
						autocomplete="current-password"
						bind:value={deletePassword}
					/></label
				>{#if error}<p class="error" role="alert">{error}</p>{/if}<button
					class="primary danger-button full"
					disabled={busy}>Permanently delete my account</button
				>
			</form>
		{:else if (modal === 'reset' || (modal === 'recover' && capabilities.emailDelivery)) && !managedAuth}<span
				class="dialog-spark">✳</span
			>
			<h2>{modal === 'reset' ? 'Reset password' : 'Forgot your password?'}</h2>
			<p class="muted">
				{modal === 'reset'
					? 'Choose a new password to open your kitchen again.'
					: 'We’ll email a link to reset your password.'}
			</p>
			<form onsubmit={recover}>
				{#if modal === 'reset'}<label class="field"
						>New password<input
							type="password"
							required
							minlength="10"
							maxlength="128"
							autocomplete="new-password"
							bind:value={password}
						/></label
					>{:else}<label class="field"
						>Email address<input
							type="email"
							required
							autocomplete="email"
							bind:value={email}
						/></label
					>{/if}{#if error}<p class="error" role="alert">{error}</p>{/if}<button
					class="primary full"
					disabled={busy}
					>{busy
						? 'One moment…'
						: modal === 'reset'
							? 'Reset password'
							: 'Send reset link'}<ArrowRight size={17} /></button
				>
			</form>
		{:else if modal === 'deleteRecipe'}<span class="dialog-spark">✳</span>
			<h2>Delete saved recipe?</h2>
			<p class="muted">
				{recipeToDelete?.title} will be removed from your collection. This also removes {kitchen.meals.filter(
					(meal) => meal.recipeId === recipeToDelete?.id
				).length} planned or cooked meal entries and your personal rating.
			</p>
			<div class="dialog-actions">
				<button class="secondary" onclick={closeDialog}>Keep recipe</button>
				<button class="primary danger-action" onclick={confirmDeleteRecipe}>Delete recipe</button>
			</div>
		{:else if modal === 'editMeal'}
			{@const editingMeal = kitchen.meals.find((meal) => meal.id === editingMealId)}
			{@const editingMealRecipe = kitchen.recipes.find(
				(recipe) => recipe.id === editingMeal?.recipeId
			)}
			<h2>Edit planned meal</h2>
			<p class="muted">{editingMealRecipe?.title}</p>
			<form onsubmit={saveMealChanges}>
				<label class="field"
					>When are we cooking?<input type="date" required bind:value={mealDate} /></label
				>
				<label class="field"
					>Meal<select required bind:value={mealSlot}
						><option>Breakfast</option><option>Lunch</option><option>Dinner</option></select
					></label
				>
				<label class="field"
					>Servings<input
						type="number"
						min="1"
						max={MAX_SERVINGS}
						step="1"
						required
						bind:value={plannedServings}
					/></label
				>
				<div class="dialog-actions">
					<button class="secondary" type="button" onclick={closeDialog}>Cancel</button><button
						class="primary"
						type="submit">Save meal</button
					>
				</div>
			</form>
		{:else if modal === 'cookMeal'}
			{@const cookingMeal = kitchen.meals.find((meal) => meal.id === cookingMealId)}
			{@const cookingRecipe = cookingMeal ? recipesById.get(cookingMeal.recipeId) : undefined}
			<h2>Mark meal cooked</h2>
			<p class="muted">{cookingRecipe?.title}</p>
			<form onsubmit={markMealCooked}>
				<label class="cook-option"
					><input type="checkbox" bind:checked={deductPantry} /><span
						><b>Deduct ingredients from pantry</b><small
							>Uses the planned serving amount and available matching stock.</small
						></span
					></label
				>
				<label class="field"
					>Leftover servings<input
						type="number"
						min="0"
						max={cookingMeal?.servings ?? MAX_SERVINGS}
						step="1"
						required
						bind:value={leftoverServings}
					/><small class="field-help">Enter 0 if there are no leftovers.</small></label
				>
				<div class="dialog-actions">
					<button class="secondary" type="button" onclick={closeDialog}>Cancel</button><button
						class="primary"
						type="submit"><Check size={17} /> Mark cooked</button
					>
				</div>
			</form>
		{:else if modal === 'plan'}
			<h2>Schedule a recipe</h2>
			<p class="muted">{selected?.title}</p>
			<form onsubmit={addMeal}>
				<label class="field"
					>When are we cooking?<input type="date" required bind:value={mealDate} /></label
				><label class="field"
					>Meal<select required bind:value={mealSlot}
						><option>Breakfast</option><option>Lunch</option><option>Dinner</option></select
					></label
				><label class="field"
					>Servings<input
						type="number"
						min="1"
						max={MAX_SERVINGS}
						step="1"
						required
						bind:value={plannedServings}
					/></label
				><button class="primary full" type="submit"
					><CalendarDays size={17} /> Put it on the calendar</button
				>
			</form>
		{:else if modal === 'pickRecipe'}
			<h2>Choose a recipe</h2>
			<div class="pick-list">
				{#each kitchen.recipes as recipe}<button
						type="button"
						onclick={() => choosePickedRecipe(recipe)}
						><img
							src={recipe.image || recipePlaceholder(recipe)}
							onerror={(event) => recipeImageError(event, recipe)}
							alt=""
							width="75"
							height="60"
							loading="lazy"
							decoding="async"
						/><span><b>{recipe.title}</b><small>{recipe.time} min · {recipe.cuisine}</small></span
						><Plus size={17} /></button
					>{/each}
			</div>
		{:else if modal === 'taste'}<span class="dialog-spark">✷</span>
			<h2>Recipe preferences</h2>
			<p class="muted">
				Rate recipes after cooking. Your favorite cuisines, cooking times, and complexity are
				included in the prompt for your next AI recipe.
			</p>
			<div class="taste-summary">{String(preferenceSummary(kitchen.recipes))}</div>
			<button class="primary full" onclick={openOnboarding}
				>Edit preferences <ArrowRight size={17} /></button
			>
		{:else if modal === 'search'}<span class="dialog-spark">✳</span>
			<h2>Find recipes online</h2>
			<p class="muted">Search real recipes across the web, with links to the original creators.</p>
			{#if !capabilities.recipeSearch}<p class="field-help">
					Web search is unavailable. Ask the server operator to enable online recipe search.
				</p>{/if}
			<label class="field"
				>What are you craving?<input
					bind:value={prompt}
					placeholder="Lemony weeknight pasta…"
				/></label
			><button
				class="primary full"
				disabled={busy || !capabilities.recipeSearch}
				onclick={internetSearch}
				><Search size={17} />{busy ? 'Looking for something good…' : 'Search recipes'}</button
			>{#if error}<p class="error" role="alert">{error}</p>{/if}
			<button class="secondary full" onclick={() => openImport()}
				><Plus size={17} />Import text, a link, or a photo</button
			>
			<div class="web-results">
				{#each searchResults as result}<div class="web-result">
						<a href={result.url} target="_blank" rel="noreferrer"
							><b>{result.title}<ArrowUpRight size={17} /></b>
							<p>{result.description}</p></a
						><button class="secondary" disabled={busy} onclick={() => importRecipe(result.url)}
							><Plus size={16} /> Import recipe</button
						>
					</div>{/each}
			</div>
		{/if}
	</ModalDialog>{/if}

<style>
	.voice-session {
		position: sticky;
		top: 0;
		z-index: 5;
		background: var(--surface);
		padding: 16px;
		margin-bottom: 16px;
		border-bottom: 2px solid var(--accent);
	}
	.voice-session.voice-recovery {
		border-bottom-color: var(--danger-ink);
	}
	.voice-session p {
		font-size: 16px;
		margin: 0 0 10px;
	}
	.voice-session .voice-error-copy {
		color: var(--danger-ink);
		font-weight: 500;
	}
	.voice-session .voice-recovery-note {
		font-size: 14px;
		color: var(--muted);
		margin-bottom: 12px;
	}
	.voice-session .dialog-actions {
		flex-wrap: wrap;
		margin-top: 12px;
	}
	.voice-session .voice-recovery-actions .primary:last-child {
		margin-left: 0;
	}
	.scan-status {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
		padding: 12px 14px;
		margin: 14px 0 16px;
		background: var(--wash);
		border: 1px solid var(--line);
		border-left: 3px solid var(--green);
		font-size: 14px;
	}
	.scan-status > span {
		display: inline-flex;
		align-items: center;
		gap: 9px;
		min-width: 0;
		font-weight: 500;
	}
	.scan-status button {
		min-width: 46px;
		min-height: 46px;
		padding: 10px 16px;
		background: var(--surface);
	}
	.scan-status :global(.scan-spin) {
		animation: gentle-turn 1.4s linear infinite;
	}
	@media (prefers-reduced-motion: reduce) {
		.scan-status :global(.scan-spin) {
			animation: none;
		}
	}

	.pantry-controls {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin: 18px 0 10px;
	}
	.pantry-filter-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
	}
	.pantry-search {
		flex: 1 1 220px;
		max-width: 320px;
		min-height: 44px;
	}
	.pantry-search input {
		width: 100%;
		min-width: 0;
		font-size: 14px;
		padding: 9px 10px;
	}
	.pantry-categories {
		padding-bottom: 4px;
	}
	.expiry-filters {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		margin: 0;
	}
	.expiry-filters :global(button) {
		min-height: 44px;
		display: inline-flex;
		align-items: center;
		gap: 9px;
		padding: 8px 12px;
		border: 1px solid var(--control-border);
		background: var(--surface);
		font-size: 14px;
	}
	.expiry-filters :global(button.active) {
		padding: 7px 11px;
		background: var(--chip-active-bg);
		color: var(--ink);
		border: 2px solid var(--chip-active-border);
		font-weight: 700;
	}
	.expiry-filters .expiry-count {
		min-width: 22px;
		padding: 2px 5px;
		background: color-mix(in srgb, currentColor 12%, transparent);
		text-align: center;
	}
	.pantry-summary-meta {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px 18px;
	}
	.pantry-summary-meta > button {
		min-height: 44px;
		min-width: 44px;
	}
	.pantry-ingredient {
		min-width: 0;
	}
	.ingredient-meta {
		min-width: 0;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 4px;
	}
	.ingredient-title-line {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 6px;
	}
	.sample-badge {
		padding: 1px 6px;
		border: 1px solid var(--line);
		background: var(--wash);
		color: var(--muted);
		font-size: 11px;
		font-weight: 500;
		letter-spacing: 0.4px;
		text-transform: uppercase;
	}
	.pantry-name {
		overflow-wrap: anywhere;
	}
	.ingredient-tags {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 6px 8px;
	}
	.category-badge {
		display: inline-flex;
		align-items: center;
		padding: 2px 7px;
		background: var(--wash);
		color: var(--muted);
		font-size: 12px;
		line-height: 1.35;
	}
	.pantry-amount {
		font-weight: 500;
		overflow-wrap: anywhere;
	}
	.pantry-expiry {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		min-width: 0;
	}
	.pantry-date {
		font-size: 12px;
		color: var(--muted);
	}
	.use-first,
	.restock-item {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		min-height: 44px;
		min-width: 44px;
		padding: 6px 0;
		font-size: 13px;
	}
	.depleted-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 14px;
	}
	.depleted-actions button {
		min-height: 44px;
		min-width: 44px;
	}
	.discover-pantry-bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 12px 14px;
		margin-bottom: 20px;
		background: var(--wash);
		border: 1px solid var(--line);
		font-size: 14px;
	}
	.discover-pantry-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px;
	}
	.discover-pantry-actions button {
		min-height: 44px;
		min-width: 44px;
	}
	.pantry-row-actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 4px;
	}
	.pantry-edit-button {
		padding: 6px 8px;
		font-size: 14px;
	}
	.pantry-remove-button {
		display: grid;
		place-items: center;
		width: 36px;
		height: 36px;
	}
	.pantry-edit-form {
		display: flex;
		flex-direction: column;
		gap: 12px;
		width: 100%;
	}
	.pantry-edit-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		flex-wrap: wrap;
	}
	.pantry-edit-actions {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-left: auto;
	}
	.pantry-done-button,
	.pantry-cancel-button {
		min-height: 38px;
		padding: 7px 12px;
		font-size: 14px;
	}
	.pantry-edit-fields {
		display: grid;
		grid-template-columns: minmax(90px, 0.8fr) minmax(100px, 1fr) minmax(130px, 1.2fr) minmax(
				140px,
				1.2fr
			);
		gap: 10px;
	}
	.pantry-field {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 4px;
		min-width: 0;
		font-size: 12px;
		font-weight: 500;
		color: var(--muted);
	}
	.pantry-field input {
		width: 100%;
		max-width: none;
		min-width: 0;
		min-height: 40px;
		padding: 7px 9px;
		font-size: 14px;
		font-weight: 400;
		color: var(--ink);
		background: var(--surface);
		border: 1px solid var(--control-border);
	}
	.filtered-pantry-empty {
		padding: 32px 12px;
	}
	.filtered-pantry-empty button {
		min-height: 44px;
		padding: 8px 14px;
	}
	.shopping-edit-form {
		display: contents;
	}
	.shopping-item-edit {
		min-width: 100px;
		flex: 1 1 180px;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	button.shopping-name {
		width: 100%;
		min-width: 0;
		min-height: 44px;
		padding: 8px 5px;
		display: flex;
		align-items: center;
		text-align: left;
		font-weight: 500;
		overflow-wrap: anywhere;
	}
	.shopping-row.checked button.shopping-name {
		color: var(--muted);
	}
	input.shopping-name {
		width: 100%;
		min-width: 0;
		min-height: 44px;
		padding: 7px 5px;
		border: 1px solid var(--control-border);
		background: var(--surface);
		font-size: 16px;
		font-weight: 500;
	}
	.shopping-source {
		padding-left: 5px;
		color: var(--muted);
		font-size: 12px;
	}
	.shopping-row .shopping-quantity {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 5px;
		white-space: nowrap;
	}
	.shopping-quantity input {
		min-width: 0;
		min-height: 44px;
		width: 72px;
		padding: 7px 5px;
		border: 1px solid var(--control-border);
		background: var(--surface);
		text-align: right;
		font-size: 16px;
	}
	.shopping-quantity input:last-child {
		width: 70px;
		text-align: left;
	}
	.calendar-meal-actions {
		min-height: 34px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 2px;
		padding: 2px 6px 0;
	}
	.calendar-meal-actions .text-button {
		min-height: 32px;
		padding: 3px 2px;
		font-size: 12px;
	}
	.calendar-meal-actions .remove-meal {
		position: static;
		min-width: 30px;
		min-height: 30px;
		display: grid;
		place-items: center;
	}
	.cooked-badge {
		color: var(--green);
		font-size: 12px;
		font-weight: 600;
	}
	.cooked-history {
		margin: 38px 0 12px;
	}
	.cooked-history .section-line {
		padding-bottom: 12px;
		border-bottom: 1px solid var(--line);
	}
	.cooked-history .section-line h2 {
		font-size: 20px;
	}
	.cooked-history-list {
		display: flex;
		flex-direction: column;
	}
	.cooked-history-row {
		display: grid;
		grid-template-columns: 54px minmax(0, 1fr) auto;
		align-items: center;
		gap: 12px;
		padding: 12px 0;
		border-bottom: 1px solid var(--line);
	}
	.cooked-history-row img {
		width: 54px;
		height: 48px;
		object-fit: cover;
	}
	.cooked-history-row > div {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.cooked-history-row b {
		font-weight: 600;
	}
	.cooked-history-row span,
	.history-empty {
		color: var(--muted);
		font-size: 14px;
	}
	.cooked-history-actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		flex-wrap: wrap;
		gap: 8px;
	}
	.cooked-history-actions button {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		min-height: 44px;
	}
	.history-empty {
		margin-top: 12px;
	}
	.history-more {
		margin-top: 16px;
		min-height: 44px;
	}
	.cook-option {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		min-height: 44px;
		padding: 12px 14px;
		margin: 22px 0;
		border: 1px solid var(--control-border);
		background: var(--surface);
		cursor: pointer;
		font-size: 14px;
	}
	.cook-option input {
		width: 24px;
		height: 24px;
		flex: 0 0 24px;
		margin-top: 1px;
		accent-color: var(--ink);
	}
	.cook-option span {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.cook-option small {
		color: var(--muted);
		line-height: 1.5;
	}
	@media (max-width: 650px) {
		.pantry-controls {
			gap: 8px;
			margin: 12px 0 6px;
		}
		.pantry-filter-bar {
			flex-direction: column;
			align-items: stretch;
			gap: 8px;
		}
		.pantry-search {
			flex: 0 0 auto;
			max-width: none;
			width: 100%;
		}
		.pantry-search input {
			font-size: 16px;
		}
		.expiry-filters {
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
			width: 100%;
		}
		.expiry-filters :global(button) {
			justify-content: center;
			gap: 5px;
			padding-inline: 6px;
			font-size: 12px;
		}
		.expiry-filters :global(button.active) {
			padding-inline: 5px;
		}
		.ingredient-meta {
			flex-direction: row;
			flex-wrap: wrap;
			align-items: center;
			gap: 3px 7px;
		}
		.pantry-amount {
			font-size: 13px;
			color: var(--ink);
			white-space: nowrap;
		}
		.pantry-expiry {
			flex-direction: row;
			align-items: center;
			flex-wrap: wrap;
			gap: 5px;
		}
		.pantry-expiry::before {
			content: '·';
			color: var(--muted);
			font-size: 12px;
		}
		.use-first,
		.restock-item {
			min-height: 44px;
			min-width: 44px;
			padding: 6px 4px;
		}
		.pantry-row-actions {
			gap: 2px;
		}
		.pantry-edit-button,
		.pantry-done-button,
		.pantry-cancel-button {
			min-width: 44px;
			min-height: 44px;
			padding: 8px 10px;
		}
		.pantry-remove-button {
			width: 44px;
			min-width: 44px;
			height: 44px;
			min-height: 44px;
		}
		.pantry-edit-fields {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 8px 10px;
		}
		.pantry-field input {
			min-height: 44px;
			padding: 8px;
			font-size: 16px;
		}
		.shopping-row {
			flex-wrap: wrap;
			align-items: center;
		}
		.shopping-item-edit {
			flex-basis: calc(100% - 66px);
		}
		.shopping-quantity {
			flex: 1 1 auto;
			margin-left: 44px !important;
		}
		.cooked-history-row {
			grid-template-columns: 46px minmax(0, 1fr);
			gap: 8px 10px;
		}
		.cooked-history-row img {
			width: 46px;
			height: 44px;
		}
		.cooked-history-actions {
			grid-column: 2;
			justify-content: flex-start;
		}
	}
	.household-members {
		margin-top: 10px;
	}
	.household-members .member-row {
		gap: 9px;
		flex-wrap: wrap;
		padding: 12px 0;
	}
	.member-copy {
		min-width: 0;
		flex: 1 1 125px;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.member-copy span {
		font-size: 13px;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.member-remove {
		min-height: 40px;
		padding-inline: 6px;
		font-size: 13px;
	}
	.household-invites {
		margin-top: 22px;
		padding: 18px 0 4px;
		border-top: 1px solid var(--line);
	}
	.household-invites h3 {
		margin-bottom: 6px;
	}
	.invite-list {
		margin: 8px 0 14px;
	}
	.invite-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-height: 44px;
		border-bottom: 1px solid var(--line);
		font-size: 14px;
	}
	.invite-row button {
		min-height: 40px;
		padding-inline: 6px;
	}
	@media (forced-colors: active) {
		.expiry-filters :global(button.active) {
			background: Highlight;
			color: HighlightText;
			border: 1px solid Highlight;
			forced-color-adjust: none;
		}
	}
</style>
