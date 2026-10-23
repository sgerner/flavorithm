<script lang="ts">
	import { onMount, tick } from 'svelte';
	import type { PageData } from './$types';
	import { focusTrap } from '#lib/focus.ts';
	import {
		backdropMotion,
		dialogMotion,
		revealMotion,
		fadeMotion,
		motionDuration
	} from '#lib/motion.ts';
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
	import { buildShoppingList, preferenceSummary } from '#lib/domain.ts';
	import { completeMeal, expiryStatus, reconcileShoppingList } from '#lib/kitchen-workflows.ts';
	import { rankRecipes } from '#lib/discovery.ts';
	import { insertRecipes } from '#lib/recipe-collection.ts';
	import RecipeDetail from '#lib/components/RecipeDetail.svelte';
	import RecipeEditor from '#lib/components/RecipeEditor.svelte';
	import SyncStatus from '#lib/components/SyncStatus.svelte';
	import AIConnection from '#lib/components/AIConnection.svelte';
	import type { ConnectionProvider, ConnectionModel } from '#lib/ai-connections.ts';
	import { createKitchenSync } from '#lib/client-sync.ts';
	import type { SyncConflict } from '#lib/offline-sync.ts';
	import RecipeImport, {
		emptyImportSession,
		type ImportSession
	} from '#lib/components/RecipeImport.svelte';
	type AuthMode = 'local' | 'oidc' | 'proxy' | 'invalid';
	let { data }: { data: PageData } = $props();
	let kitchen = $state<AppState>(createInitialState());
	let user = $state<User | null>(null);
	let ready = $state(false);
	let kitchenLoaded = $state(false);
	let runtimeAuthMode = $state<AuthMode | null>(null);
	let installationAuthMode = $derived(runtimeAuthMode ?? data.authMode);
	let managedAuth = $derived(installationAuthMode !== 'local');
	let authMetadataLoaded = $state(false);
	let runtimeLoginUrl = $state<string | null>(null);
	let runtimeLogoutUrl = $state<string | null>(null);
	let providerLoginUrl = $derived(authMetadataLoaded ? runtimeLoginUrl : data.loginUrl);
	let providerLogoutUrl = $derived(authMetadataLoaded ? runtimeLogoutUrl : data.logoutUrl);
	let online = $state(true);
	let pendingSync = $state(false);
	let sendingSync = $state(false);
	let syncErrors = $state('');
	let conflicts = $state<SyncConflict[]>([]);
	let kitchenSync: ReturnType<typeof createKitchenSync> | undefined;
	let page = $state('discover');
	let filter = $state('For you');
	let query = $state('');
	let toast = $state('');
	let busy = $state(false);
	let mobileNav = $state(false);
	let modal = $state('');
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
		modal = 'auth';
	}
	function clearManagedIdentity() {
		clearAIConnectionState();
		kitchenSync?.clearContext();
		user = null;
		kitchen = createInitialState();
		kitchenLoaded = false;
		showStarter = false;
		stateEtag = null;
		localStorage.removeItem('flavorithm-last-account');
		localStorage.removeItem('flavorithm-kitchen');
		members = [];
		householdInvites = [];
		canManageHousehold = false;
		inviteCode = '';
		currentInviteId = '';
		joinCode = '';
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
	let recipeToDelete = $state<Recipe | null>(null);
	let pantryInput = $state('');
	let authMode = $state('register');
	let name = $state('');
	let email = $state('');
	let password = $state('');
	let error = $state('');
	let apiKey = $state('');
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
		configured: boolean;
		mode: string;
		safeReason?: string;
		accounts: ChatGPTAccount[];
	}>({ configured: false, mode: 'unavailable', accounts: [] });
	let connectionBusy = $state(false);
	let chatGPTAuthorizationUrl = $state('');
	let connectionPoll: ReturnType<typeof setInterval> | undefined;
	let connectionPopup: Window | null = null;
	let connectionPollCount = 0;
	let connectionAttempt = 0;
	let activeChatGPTAccount = $derived(
		chatGPT.accounts.find((a) => a.id === kitchen.preferences.chatgptAccountId)
	);

	let providers = $state<ConnectionProvider[]>([]);
	let accountModels = $state<ConnectionModel[]>([]);
	let catalogLoading = $state(false);
	let catalogError = $state('');
	let catalogVersion = 0;
	let chatGPTCompanion = $state<{ script: string; filename: string; expiresAt: number } | null>(
		null
	);
	let prompt = $state('');
	let importSession = $state<ImportSession>(emptyImportSession());
	let resumeImport = $state(false);
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
	let mealDate = $state('');
	let mealSlot = $state('Dinner');
	let plannedServings = $state(2);
	let editingMealId = $state('');
	let cookingMealId = $state('');
	let deductPantry = $state(false);
	let leftoverServings = $state(0);
	let pantryFilter = $state('all');
	let shoppingText = $state('');
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
		const modeChanged = previousMode !== installationAuthMode;
		const changedIdentity = Boolean(
			(previousUser &&
				(previousUser.id !== data.user?.id ||
					previousUser.householdId !== data.user?.householdId)) ||
			(modeChanged && managedAuth && data.user)
		);
		if (modeChanged && managedAuth) clearManagedIdentity();
		if (changedIdentity) {
			kitchenSync?.clearContext();
			clearAIConnectionState();
		}
		user = data.user ?? null;
		if (managedAuth && !user) {
			clearManagedIdentity();
			renewManagedSession({ status: 401 });
		}
		if (changedIdentity) {
			if (user) {
				const latest = await request('/api/state');
				adoptKitchen(latest.state || createNewUserState());
				kitchenLoaded = true;
			} else if (managedAuth) {
				clearManagedIdentity();
			} else {
				kitchen = createInitialState();
				localStorage.removeItem('flavorithm-last-account');
				kitchenLoaded = true;
			}
		}
		capabilities = {
			emailDelivery: Boolean(data.capabilities?.emailDelivery),
			recipeSearch: Boolean(data.capabilities?.recipeSearch)
		};
		return data;
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
	let recipes = $derived.by(() => {
		const matches = kitchen.recipes.filter(
			(r) =>
				(page !== 'saved' || r.saved) &&
				(!query ||
					`${r.title} ${r.cuisine} ${r.tags.join(' ')}`
						.toLowerCase()
						.includes(query.toLowerCase())) &&
				(filter !== 'Quick & easy' || r.time <= 30) &&
				(filter !== 'Plant-powered' || r.tags.some((t) => /vegetarian|vegan|plant/i.test(t))) &&
				(filter !== 'Comfort food' || r.tags.some((t) => /comfort/i.test(t))) &&
				(filter !== 'High protein' || r.nutrition.protein >= 25)
		);
		return filter === 'For you'
			? rankRecipes(matches, kitchen.pantry, kitchen.preferences)
			: matches.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
	});
	let visiblePantry = $derived(
		kitchen.pantry.filter(
			(item) => pantryFilter === 'all' || expiryStatus(item.expires) === pantryFilter
		)
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
	function notify(message: string) {
		toast = message;
		setTimeout(() => {
			if (toast === message) toast = '';
		}, 4200);
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
				syncing = true;
				clearTimeout(saveTimer);
				notify(
					'Your household changed in another tab. Reload to pick up the latest kitchen before making more changes.'
				);
			}
			throw Object.assign(new Error(data.error || 'Something went wrong. Please try again.'), {
				status: response.status
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
	let stateEtag: string | null = null;
	let writeChain = Promise.resolve();
	let saveTimer: ReturnType<typeof setTimeout>;
	$effect(() => {
		const snapshot = JSON.stringify(kitchen);
		if (!ready) return;
		document.documentElement.dataset.theme = kitchen.preferences.theme;
		document.documentElement.classList.toggle('dark', kitchen.preferences.dark);
		if (managedAuth && (!user || !kitchenLoaded)) return;
		if (!managedAuth) {
			try {
				localStorage.setItem('flavorithm-kitchen', snapshot);
			} catch {
				notify('Device storage is full. Export your kitchen before leaving.');
			}
		}
		if (user) kitchenSync?.stage(JSON.parse(snapshot));
		clearTimeout(saveTimer);
		if (user && !syncing && online)
			saveTimer = setTimeout(() => {
				void retrySync();
			}, 500);
	});
	onMount(() => {
		online = navigator.onLine;
		kitchenSync = createKitchenSync({
			storage: localStorage,
			getUser: () => user,
			getState: () => JSON.parse(JSON.stringify(kitchen)),
			setState: (state) => {
				kitchen = state;
			},
			onStatus: (status) => {
				pendingSync = status.pending;
				sendingSync = status.syncing;
				conflicts = status.conflicts;
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
			localStorage.removeItem('flavorithm-kitchen');
			kitchen = createInitialState();
			showStarter = false;
		} else {
			try {
				const local = localStorage.getItem('flavorithm-kitchen');
				if (local) {
					kitchen = JSON.parse(local);
					if (!themes.includes(kitchen.preferences.theme)) kitchen.preferences.theme = 'nosh';
				}
			} catch {}
			showStarter = localStorage.getItem('flavorithm-started') !== 'yes';
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
					localStorage.removeItem('flavorithm-kitchen');
					kitchen = createInitialState();
					kitchenLoaded = false;
					showStarter = false;
				}
				capabilities = {
					emailDelivery: Boolean(data.capabilities?.emailDelivery),
					recipeSearch: Boolean(data.capabilities?.recipeSearch)
				};
				syncing = true;
				user = data.user ?? null;
				if (!user) {
					kitchenSync?.clearContext();
					localStorage.removeItem('flavorithm-last-account');
					if (managedAuth) {
						clearManagedIdentity();
						renewManagedSession({ status: 401 });
					}
				}
				if (data.user) {
					const saved = await request('/api/state');
					adoptKitchen(saved.state || createNewUserState());
					kitchenLoaded = true;
				}
				user = data.user ?? null;
				if (user) showStarter = false;
				syncing = false;
				if (user && returnFromChatGPT) await openSettings();
				if (user)
					await refreshConnections().catch(() =>
						notify('Your ChatGPT connection could not be checked. Open Settings to reconnect.')
					);
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
							user = cached;
							kitchenSync?.restore(cached);
						}
					} catch {}
				}
				syncing = false;
				notify(
					managedAuth
						? 'Your organization session could not be confirmed. Reconnect to continue.'
						: 'Working locally. Pending edits will retry when you reconnect.'
				);
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
		window.addEventListener('online', connectionChanged);
		window.addEventListener('offline', connectionChanged);
		window.addEventListener('beforeinstallprompt', install);
		return () => {
			window.removeEventListener('beforeinstallprompt', install);
			window.removeEventListener('online', connectionChanged);
			window.removeEventListener('offline', connectionChanged);
			clearTimeout(saveTimer);
			clearInterval(connectionPoll);
		};
	});
	function adoptKitchen(state: AppState) {
		if (user && kitchenSync) {
			kitchenSync.initialize(JSON.parse(JSON.stringify(user)), state, stateEtag || '');
			if (!managedAuth) {
				try {
					localStorage.setItem('flavorithm-last-account', JSON.stringify(user));
				} catch {}
			}
		} else kitchen = state;
	}
	async function retrySync(prefer?: 'local' | 'remote') {
		if (!online || !user || !kitchenSync) return;
		try {
			await kitchenSync.sync(prefer);
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
			const previous = user;
			await refreshAuth();
			if (!user) {
				kitchenSync?.clearContext();
				if (managedAuth) {
					clearManagedIdentity();
					renewManagedSession({ status: 401 });
				} else notify('Sign in again to sync the edits saved on this device.');
				return;
			}
			if (previous?.id !== user.id || previous?.householdId !== user.householdId)
				kitchenSync?.clearContext();
			const latest = await request('/api/state');
			adoptKitchen(latest.state || createNewUserState());
			await retrySync();
		} catch (e) {
			syncErrors = (e as Error).message;
			if (managedAuth) {
				clearManagedIdentity();
				renewManagedSession(e);
			}
		}
	}
	function exportPendingChanges() {
		const snapshot = kitchenSync?.snapshot();
		if (snapshot)
			download(
				JSON.stringify(snapshot.local, null, 2),
				'flavorithm-pending-kitchen.json',
				'application/json'
			);
	}
	async function flushKitchen() {
		clearTimeout(saveTimer);
		await writeChain;
		if (user && kitchenSync) {
			kitchenSync.stage(JSON.parse(JSON.stringify(kitchen)));
			await kitchenSync.sync();
			if (kitchenSync.snapshot())
				throw new Error(
					'Sync or back up your pending kitchen changes before switching accounts or households.'
				);
		}
	}

	function freshKitchen() {
		kitchen.pantry = [];
		kitchen.meals = [];
		kitchen.shopping = [];
		kitchen.recipes = kitchen.recipes.map((r) => ({ ...r, rating: undefined, saved: false }));
		showStarter = false;
		localStorage.setItem('flavorithm-started', 'yes');
		page = 'pantry';
		modal = 'pantry';
		notify('Sample pantry and meal plan cleared. Starter recipes kept.');
	}
	function navigate(id: string) {
		page = id;
		query = '';
		filter = 'For you';
		mobileNav = false;
	}
	function addIngredients() {
		const names = pantryInput
			.split(/[,\n;]/)
			.map((s) => s.trim())
			.filter(Boolean);
		for (const value of names) {
			const match = value.match(
				/^(\d+(?:\.\d+)?)\s*(g|kg|oz|lbs?|ml|l|cups?|tbsp|tsp|pieces?|whole|each|cans?|cloves?|bunch)?\s+(.+)$/i
			);
			kitchen.pantry.push({
				id: crypto.randomUUID(),
				name: match ? match[3] : value,
				quantity: match ? Number(match[1]) : 1,
				unit: match?.[2] || 'piece',
				category: 'Pantry'
			});
		}
		pantryInput = '';
		modal = '';
		notify(`${names.length} ingredients added to your pantry.`);
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
			clearTimeout(saveTimer);
			const guestTaste =
				authMode === 'register' && kitchen.preferences.onboardingStatus
					? {
							maxTime: kitchen.preferences.maxTime,
							complexity: kitchen.preferences.complexity,
							cuisines: [...(kitchen.preferences.cuisines ?? [])],
							diet: kitchen.preferences.diet,
							allergies: kitchen.preferences.allergies,
							onboardingStatus: kitchen.preferences.onboardingStatus
						}
					: null;
			const result = await request('/api/auth', { action: authMode, name, email, password });
			user = result.user;
			const saved = await request('/api/state');
			if (saved.state) adoptKitchen(saved.state);
			else {
				kitchen = createNewUserState();
				await request('/api/state', { state: kitchen }, 'PUT');
			}
			if (guestTaste) Object.assign(kitchen.preferences, guestTaste);
			user = result.user;
			showStarter = false;
			syncing = false;
			await refreshConnections().catch(() =>
				notify('Your ChatGPT connection could not be checked. Open Settings to reconnect.')
			);
			password = '';
			if (resumeImport) {
				resumeImport = false;
				modal = 'import';
			} else {
				modal = '';
				if (authMode === 'register' && !kitchen.preferences.onboardingStatus) openOnboarding();
			}
			notify(`Welcome to your kitchen, ${user?.name.split(' ')[0]}.`);
		} catch (e) {
			error = (e as Error).message;
		} finally {
			busy = false;
			syncing = false;
		}
	}
	async function logout() {
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
			localStorage.removeItem('flavorithm-last-account');
			user = null;
			inviteCode = '';
			currentInviteId = '';
			joinCode = '';
			members = [];
			householdInvites = [];
			canManageHousehold = false;
			importSession = emptyImportSession();
			resumeImport = false;
			kitchen = createInitialState();
			localStorage.removeItem('flavorithm-kitchen');
			clearAIConnectionState();
			clearInterval(connectionPoll);
			connectionBusy = false;
			chatGPTAuthorizationUrl = '';
			chatGPT = { configured: false, mode: 'unavailable', accounts: [] };
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
		apiKey = '';
		providers = [];
		accountModels = [];
		catalogVersion++;
		catalogLoading = false;
		catalogError = '';
		chatGPTCompanion = null;
		clearInterval(connectionPoll);
		connectionPopup?.close();
		connectionBusy = false;
		chatGPTAuthorizationUrl = '';
		chatGPT = { configured: false, mode: 'unavailable', accounts: [] };
	}
	async function loadModelCatalog() {
		if (!user) return;
		const version = ++catalogVersion;
		const owner = user.id;
		const accountId = kitchen.preferences.chatgptAccountId;
		const isAccount =
			kitchen.preferences.provider === 'chatgpt' &&
			accountId &&
			activeChatGPTAccount?.connected &&
			activeChatGPTAccount.planEnabled;
		catalogLoading = true;
		catalogError = '';
		const [catalog, account] = await Promise.allSettled([
			request('/api/models'),
			isAccount
				? request(`/api/models?connection=chatgpt&accountId=${encodeURIComponent(accountId)}`)
				: Promise.resolve(null)
		]);
		if (version !== catalogVersion || user?.id !== owner) return;
		if (catalog.status === 'fulfilled') providers = catalog.value.providers;
		else catalogError = catalog.reason.message || 'The provider catalog could not be loaded.';
		if (account.status === 'fulfilled') accountModels = account.value?.providers[0]?.models || [];
		else {
			accountModels = [];
			catalogError = account.reason.message || 'ChatGPT models could not be loaded.';
		}
		catalogLoading = false;
	}
	async function refreshConnections() {
		if (!user) return;
		const owner = user.id;
		const result = await request('/api/connections/chatgpt');
		if (user?.id !== owner) return;
		chatGPT = result;
		if (!chatGPT.accounts.some((a) => a.id === kitchen.preferences.chatgptAccountId))
			kitchen.preferences.chatgptAccountId =
				chatGPT.accounts.find((a) => a.connected && a.planEnabled)?.id || chatGPT.accounts[0]?.id;
	}
	async function refreshAISettings() {
		error = '';
		try {
			await refreshConnections();
		} catch (e) {
			error = (e as Error).message;
		}
		await loadModelCatalog();
	}
	async function openSettings(focusAI = false) {
		mobileNav = false;
		modal = 'settings';
		error = '';
		try {
			await refreshAuth();
		} catch {
			// Keep the last known account state while showing Settings offline.
		}
		if (focusAI) {
			await tick();
			document.getElementById('ai-connection-heading')?.focus();
		}
		try {
			if (user) {
				await refreshConnections();
				await loadModelCatalog();
			}
		} catch (e) {
			error = (e as Error).message;
		}
	}
	async function changeConnection(providerId?: string) {
		if (providerId === kitchen.preferences.provider) return;
		connectionAttempt++;
		if (providerId && providerId !== kitchen.preferences.provider) {
			apiKey = '';
			kitchen.preferences.provider = providerId;
		}
		clearInterval(connectionPoll);
		connectionPopup?.close();
		connectionBusy = false;
		chatGPTAuthorizationUrl = '';
		chatGPTCompanion = null;
		kitchen.preferences.model = '';
		kitchen.preferences.reasoning = undefined;
		accountModels = [];
		error = '';
		try {
			await refreshConnections();
			await loadModelCatalog();
		} catch (e) {
			error = (e as Error).message;
		}
	}
	function downloadChatGPTCompanion() {
		if (!chatGPTCompanion) return;
		const url = URL.createObjectURL(
			new Blob([chatGPTCompanion.script], { type: 'text/javascript' })
		);
		const link = document.createElement('a');
		link.href = url;
		link.download = chatGPTCompanion.filename;
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
	async function importChatGPTConnection(file: File) {
		if (!user || connectionBusy) return;
		connectionBusy = true;
		error = '';
		const owner = user.id;
		try {
			if (file.size > 100_000)
				throw new Error(
					'Choose the encrypted connection file created by the connector (under 100 KB).'
				);
			let bundle: unknown;
			try {
				bundle = JSON.parse(await file.text());
			} catch {
				throw new Error('Choose the connector’s JSON connection file.');
			}
			const result = await request('/api/connections/chatgpt', { action: 'import', bundle });
			if (user?.id !== owner) return;
			await refreshConnections();
			kitchen.preferences.chatgptAccountId = result.accountId;
			kitchen.preferences.provider = 'chatgpt';
			kitchen.preferences.model = '';
			kitchen.preferences.reasoning = undefined;
			chatGPTCompanion = null;
			await loadModelCatalog();
			notify(
				result.planEnabled
					? 'ChatGPT connected. Choose a model.'
					: 'ChatGPT signed in. Enable plan usage to generate recipes.'
			);
		} catch (e) {
			error = (e as Error).message;
		} finally {
			connectionBusy = false;
		}
	}
	async function connectChatGPT(accountId?: string, reconsent = false) {
		if (!user) {
			openAuthentication();
			return;
		}
		const attempt = ++connectionAttempt;
		const owner = user.id;
		connectionBusy = true;
		chatGPTAuthorizationUrl = '';
		error = '';
		connectionPopup =
			chatGPT.mode === 'companion'
				? null
				: window.open('about:blank', 'flavorithm-chatgpt-connect', 'popup,width=620,height=780');
		try {
			const previousAccounts = new Map(chatGPT.accounts.map((a) => [a.id, a.updatedAt]));
			const previous = JSON.stringify(chatGPT.accounts);
			const result = await request('/api/connections/chatgpt', {
				action: 'start',
				accountId,
				reconsent
			});
			if (attempt !== connectionAttempt || user?.id !== owner) return;
			if (result.kind === 'companion') {
				connectionPopup?.close();
				chatGPTCompanion = result;
				connectionBusy = false;
				return;
			}
			chatGPTAuthorizationUrl = result.authorizationUrl;
			if (connectionPopup) connectionPopup.location.href = result.authorizationUrl;
			else if (importSession.text || importSession.photo || importSession.draft) {
				chatGPTAuthorizationUrl = result.authorizationUrl;
			} else {
				window.location.assign(result.authorizationUrl);
				return;
			}
			clearInterval(connectionPoll);
			connectionPollCount = 0;
			let polling = false;
			connectionPoll = setInterval(async () => {
				if (polling || attempt !== connectionAttempt || user?.id !== owner) return;
				polling = true;
				try {
					await refreshConnections();
					if (attempt !== connectionAttempt || user?.id !== owner) return;
					connectionPollCount++;
					const connectionChanged = JSON.stringify(chatGPT.accounts) !== previous;
					if (connectionChanged || connectionPopup?.closed) {
						clearInterval(connectionPoll);
						connectionBusy = false;
						chatGPTAuthorizationUrl = '';
						const account = chatGPT.accounts.find(
							(a) =>
								a.connected &&
								(accountId
									? a.id === accountId
									: !previousAccounts.has(a.id) || previousAccounts.get(a.id) !== a.updatedAt)
						);
						if (account && connectionChanged) {
							kitchen.preferences.chatgptAccountId = account.id;
							kitchen.preferences.provider = 'chatgpt';
							kitchen.preferences.model = '';
							kitchen.preferences.reasoning = undefined;
							await loadModelCatalog();
							connectionPopup?.close();
							notify(
								account.planEnabled
									? 'ChatGPT connected. Choose a model to cook with your plan.'
									: 'ChatGPT signed in. Enable plan usage to generate recipes.'
							);
						} else if (!connectionChanged) {
							notify('The authorization window closed. Your previous connection is unchanged.');
						}
					}
					if (connectionPollCount >= 400) {
						clearInterval(connectionPoll);
						connectionBusy = false;
						chatGPTAuthorizationUrl = '';
						error = 'The connection window timed out. Try connecting again.';
					}
				} catch (e) {
					clearInterval(connectionPoll);
					connectionBusy = false;
					chatGPTAuthorizationUrl = '';
					error = (e as Error).message;
				} finally {
					polling = false;
				}
			}, 1500);
		} catch (e) {
			connectionPopup?.close();
			connectionBusy = false;
			chatGPTAuthorizationUrl = '';
			error = (e as Error).message;
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
			chatGPTCompanion = null;
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
		}
	}
	function needAI() {
		if (!user) {
			openAuthentication();
			notify(
				managedAuth
					? 'Sign in through your organization to use your AI connection.'
					: 'Create an account to use your AI connection.'
			);
			return false;
		}
		const isPlan = kitchen.preferences.provider === 'chatgpt';
		if (
			(isPlan ? !activeChatGPTAccount?.connected || !activeChatGPTAccount.planEnabled : !apiKey) ||
			!kitchen.preferences.model
		) {
			openSettings(true);
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
		return request(
			'/api/ai',
			{
				action,
				...(kitchen.preferences.provider === 'chatgpt'
					? { connectionId: kitchen.preferences.chatgptAccountId }
					: { apiKey }),
				provider: kitchen.preferences.provider,
				model: kitchen.preferences.model,
				reasoning: kitchen.preferences.reasoning,
				...(action === 'capture'
					? {}
					: {
							pantry: kitchen.pantry.filter((item) => expiryStatus(item.expires) !== 'expired'),
							preferences: kitchen.preferences,
							recipes: kitchen.recipes.filter((r) => r.rating).slice(0, 30),
							prompt
						}),
				...extra
			},
			'POST',
			signal
		);
	}
	async function generate() {
		if (!needAI()) return;
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
		const file = (event.target as HTMLInputElement).files?.[0];
		if (!file || !needAI()) return;
		if (file.size > 5 * 1024 * 1024) {
			notify('Choose a photo under 5 MB.');
			return;
		}
		busy = true;
		try {
			const image = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result));
				reader.onerror = reject;
				reader.readAsDataURL(file);
			});
			const result = await ai('vision', { image });
			pantryInput = result.ingredients
				.map((i: any) => `${i.quantity} ${i.unit} ${i.name}`)
				.join('\n');
			modal = 'pantry';
			notify('Review what we spotted before adding it.');
		} catch (e) {
			notify((e as Error).message);
		} finally {
			busy = false;
			if (imageInput) imageInput.value = '';
		}
	}
	function dictate() {
		startDictation(false);
	}
	function dictateRecipe() {
		startDictation(true);
	}
	function startDictation(forRecipe: boolean) {
		const Recognition =
			(window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
		if (!Recognition) {
			notify('Voice input is unavailable in this browser. Try Chrome or type your ingredients.');
			return;
		}
		const recognition = new Recognition();
		const inputSession = importSession;
		recognition.lang = navigator.language;
		recognition.interimResults = false;
		recognition.onresult = (e: any) => {
			if (forRecipe) {
				if (modal !== 'import' || importSession !== inputSession || importSession.draft) return;
				importSession.text = [importSession.text, e.results[0][0].transcript]
					.filter(Boolean)
					.join('\n')
					.slice(0, 20000);
			} else {
				pantryInput += (pantryInput ? ', ' : '') + e.results[0][0].transcript;
				modal = 'pantry';
				notify('Review your ingredients, then add them.');
			}
		};
		recognition.onerror = () => notify('Microphone access failed. Check browser permissions.');
		try {
			recognition.start();
			notify(
				forRecipe
					? 'Listening… describe your recipe.'
					: 'Listening… tell us what’s in your kitchen.'
			);
		} catch {
			notify('Voice input could not start. Try again or paste text.');
		}
	}
	function saveRecipe(r: Recipe) {
		r.saved = !r.saved;
		kitchen.recipes = [...kitchen.recipes];
		notify(r.saved ? 'Saved to your collection.' : 'Removed from your collection.');
	}
	function editSavedRecipe(recipe: Recipe) {
		const saved = kitchen.recipes.find((item) => item.id === recipe.id && item.saved);
		if (!saved) return;
		selected = null;
		editingRecipe = {
			...saved,
			tags: [...saved.tags],
			ingredients: saved.ingredients.map((item) => ({ ...item })),
			steps: [...saved.steps],
			nutrition: { ...saved.nutrition }
		};
	}
	function saveEditedRecipe(updated: Recipe) {
		const previous = kitchen.recipes.find((item) => item.id === updated.id);
		if (!previous || !previous.saved) {
			editingRecipe = null;
			return;
		}
		const nutritionNeedsRefresh =
			previous.servings !== updated.servings ||
			JSON.stringify(previous.ingredients) !== JSON.stringify(updated.ingredients);
		const saved = {
			...updated,
			saved: true,
			nutritionStale: nutritionNeedsRefresh ? true : previous.nutritionStale
		};
		kitchen.recipes = kitchen.recipes.map((item) => (item.id === saved.id ? saved : item));
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
	function refreshWeekShopping(startDate: string) {
		const start = new Date(`${startDate}T12:00:00`);
		if (Number.isNaN(start.getTime())) return;
		const dates = Array.from({ length: 7 }, (_, index) => {
			const day = new Date(start);
			day.setDate(day.getDate() + index);
			return dateKey(day);
		});
		const meals = kitchen.meals.filter((meal) => dates.includes(meal.date) && !meal.completedAt);
		const recipes = kitchen.recipes.filter((recipe) =>
			meals.some((meal) => meal.recipeId === recipe.id)
		);
		const usablePantry = kitchen.pantry.filter((item) => expiryStatus(item.expires) !== 'expired');
		const additions = buildShoppingList(recipes, usablePantry, meals);
		kitchen.shopping = reconcileShoppingList(kitchen.shopping, additions, `week:${startDate}`);
	}
	function confirmDeleteRecipe() {
		const recipe = recipeToDelete;
		if (!recipe) return;
		const impactedMeals = kitchen.meals.filter((meal) => meal.recipeId === recipe.id);
		const affectedWeeks = new Set(impactedMeals.map((meal) => weekStartForDate(meal.date)));
		kitchen.meals = kitchen.meals.filter((meal) => meal.recipeId !== recipe.id);
		kitchen.recipes = kitchen.recipes.filter((item) => item.id !== recipe.id);
		kitchen.shopping = kitchen.shopping.filter((item) => item.sourceKey !== `recipe:${recipe.id}`);
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
	function normalizeShoppingItem(item: AppState['shopping'][number]) {
		item.name = item.name.trim().slice(0, 100) || 'Shopping item';
		item.unit = item.unit.trim().slice(0, 40) || 'piece';
		const quantity = Number(item.quantity);
		item.quantity = Number.isFinite(quantity) ? Math.max(0.01, Math.min(quantity, 1000000)) : 1;
	}
	function shoppingFor(items: Recipe[], meals: AppState['meals'] | undefined, sourceKey: string) {
		const usablePantry = kitchen.pantry.filter((item) => expiryStatus(item.expires) !== 'expired');
		const additions = buildShoppingList(items, usablePantry, meals);
		kitchen.shopping = reconcileShoppingList(kitchen.shopping, additions, sourceKey);
		selected = null;
		page = 'shopping';
		notify(
			additions.length
				? 'Shopping list ready. Your pantry is already accounted for.'
				: 'You have everything you need. Happy cooking!'
		);
	}
	function planRecipe(r: Recipe, servings = r.servings) {
		plannedServings = servings;
		selected = r;
		mealDate = dateKey(new Date());
		modal = 'plan';
	}
	function editPlannedMeal(meal: Meal) {
		if (meal.completedAt) return;
		editingMealId = meal.id;
		mealDate = meal.date;
		mealSlot = meal.slot;
		plannedServings = meal.servings;
		modal = 'editMeal';
	}
	function saveMealChanges() {
		const meal = kitchen.meals.find((item) => item.id === editingMealId);
		if (!meal || !mealDate || !['Breakfast', 'Lunch', 'Dinner'].includes(mealSlot)) return;
		if (!Number.isInteger(plannedServings) || plannedServings < 1 || plannedServings > 24) {
			notify('Choose between 1 and 24 whole servings.');
			return;
		}
		const previousWeek = weekStartForDate(meal.date);
		meal.date = mealDate;
		meal.slot = mealSlot;
		meal.servings = Math.round(plannedServings);
		refreshWeekShopping(previousWeek);
		refreshWeekShopping(weekStartForDate(meal.date));
		editingMealId = '';
		modal = '';
		notify('Meal plan updated.');
	}
	function openCookDialog(meal: Meal) {
		if (meal.completedAt) return;
		cookingMealId = meal.id;
		deductPantry = false;
		leftoverServings = 0;
		modal = 'cookMeal';
	}
	function markMealCooked() {
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
		const startDate = weekStartForDate(meal.date);
		kitchen = completeMeal(kitchen, meal.id, {
			deductPantry,
			leftoverServings: Math.round(leftoverServings)
		});
		refreshWeekShopping(startDate);
		cookingMealId = '';
		modal = '';
		const recipe = kitchen.recipes.find((item) => item.id === recipeId);
		if (recipe) selected = recipe;
		notify(recipe ? `Marked cooked. How did you like ${recipe.title}?` : 'Meal marked cooked.');
	}
	async function useFirstIngredients(items: AppState['pantry']) {
		const names = items
			.filter((item) => expiryStatus(item.expires) === 'soon' && item.quantity > 0)
			.map((item) => item.name.trim())
			.filter(Boolean);
		if (!names.length) return;
		prompt = `Use these ingredients first, prioritizing them because they are expiring: ${names.join(', ')}. Build a practical recipe that uses as much of them as possible while following my preferences.`;
		modal = 'generate';
		await generate();
	}
	function addMeal() {
		if (!selected || !mealDate) return;
		if (!Number.isInteger(plannedServings) || plannedServings < 1 || plannedServings > 24) {
			notify('Choose between 1 and 24 whole servings.');
			return;
		}
		kitchen.meals.push({
			id: crypto.randomUUID(),
			date: mealDate,
			slot: mealSlot,
			recipeId: selected.id,
			servings: plannedServings
		});
		selected = null;
		modal = '';
		page = 'planner';
		notify('Meal scheduled.');
	}
	async function refreshHousehold() {
		const data = await request('/api/household');
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
	async function join() {
		householdBusy = true;
		try {
			syncing = true;
			clearTimeout(saveTimer);
			await flushKitchen();
			await request('/api/household', { action: 'join', code: joinCode.trim() });
			joinCode = '';
			inviteCode = '';
			currentInviteId = '';
			await refreshAuth();
			const data = await request('/api/state');
			adoptKitchen(data.state || createNewUserState());
			await refreshHousehold();
			syncing = false;
			notify('Welcome to your shared kitchen.');
		} catch (e) {
			syncing = false;
			error = (e as Error).message;
		} finally {
			syncing = false;
			householdBusy = false;
		}
	}
	async function refreshNutrition() {
		if (!selected || !needAI()) return;
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
	function closeDialog() {
		if (modal === 'plan') selected = null;
		if (modal === 'editMeal') editingMealId = '';
		if (modal === 'cookMeal') cookingMealId = '';
		if (modal === 'deleteRecipe') recipeToDelete = null;
		if (modal === 'removeMember') memberToRemove = null;
		if (modal === 'household') {
			inviteCode = '';
			currentInviteId = '';
		}
		if (modal === 'onboarding') dismissOnboarding();
		else if (resumeImport && (modal === 'settings' || modal === 'auth')) {
			resumeImport = false;
			modal = 'import';
		} else modal = '';
		error = '';
	}
	function openImport(text?: string) {
		resumeImport = false;
		if (text !== undefined) importSession = { ...emptyImportSession(), text };
		error = '';
		mobileNav = false;
		modal = 'import';
	}
	function importRecipe(url: string) {
		openImport(url);
	}
	async function captureImport(input: { prompt: string; image?: string }, signal: AbortSignal) {
		if (!needAI()) {
			resumeImport = true;
			return null;
		}
		return ai('capture', input, signal);
	}
	function saveImportedRecipe(recipe: Recipe) {
		const saved = { ...recipe, saved: true };
		kitchen.recipes = insertRecipes(kitchen.recipes, [saved]);
		importSession = emptyImportSession();
		resumeImport = false;
		modal = '';
		selected = saved;
		page = 'saved';
		query = '';
		filter = 'For you';
		notify('Recipe saved to your collection.');
	}
	async function exportKitchen() {
		try {
			const data = await request('/api/export');
			download(JSON.stringify(data, null, 2), 'flavorithm-kitchen.json', 'application/json');
		} catch (e) {
			notify((e as Error).message);
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
			if (user) {
				for (const key of Object.keys(localStorage)) {
					if (key.startsWith('flavorithm-') && key.includes(`:${user.id}:`))
						localStorage.removeItem(key);
				}
			}
			kitchenSync?.clearContext();
			localStorage.removeItem('flavorithm-last-account');
			user = null;
			inviteCode = '';
			currentInviteId = '';
			joinCode = '';
			members = [];
			householdInvites = [];
			canManageHousehold = false;
			importSession = emptyImportSession();
			resumeImport = false;
			apiKey = '';
			deletePassword = '';
			stateEtag = null;
			kitchen = createInitialState();
			localStorage.removeItem('flavorithm-kitchen');
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
		try {
			syncing = true;
			clearTimeout(saveTimer);
			await flushKitchen();
			await request('/api/household', { action: 'leave' });
			joinCode = '';
			inviteCode = '';
			currentInviteId = '';
			memberToRemove = null;
			await refreshAuth();
			const data = await request('/api/state');
			adoptKitchen(data.state || createNewUserState());
			await refreshHousehold();
			syncing = false;
			modal = '';
			notify('You now have your own kitchen.');
		} catch (e) {
			syncing = false;
			error = (e as Error).message;
		} finally {
			busy = false;
			householdBusy = false;
		}
	}

	function exportList() {
		const text = kitchen.shopping
			.map((i) => `${i.checked ? '✓' : '☐'} ${i.quantity} ${i.unit} ${i.name}`)
			.join('\n');
		const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
		const a = document.createElement('a');
		a.href = url;
		a.download = 'flavorithm-shopping.txt';
		a.click();
		URL.revokeObjectURL(url);
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

<svelte:head><title>Flavorithm — Where flavor meets algorithms</title></svelte:head>
<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape') {
			mobileNav = false;
			closeDialog();
			selected = null;
		}
	}}
/>
<input
	class="visually-hidden"
	type="file"
	accept="image/jpeg,image/png,image/webp"
	bind:this={imageInput}
	onchange={scan}
/>
<div class="app-shell" inert={!!modal || !!selected || !!editingRecipe}>
	{#if mobileNav}<button
			class="nav-backdrop"
			aria-label="Dismiss navigation"
			onclick={() => (mobileNav = false)}
			transition:backdropMotion|global
		></button>{/if}
	<aside class:mobile-open={mobileNav} class="sidebar">
		<button
			class="icon-button sidebar-close"
			aria-label="Close navigation"
			onclick={() => (mobileNav = false)}><X size={20} /></button
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
			><button
				onclick={() => {
					kitchen.preferences.dark = !kitchen.preferences.dark;
				}}
				>{#if kitchen.preferences.dark}<Sun size={18} />{:else}<Moon size={18} />{/if}{kitchen
					.preferences.dark
					? 'Light mode'
					: 'Dark mode'}<span class="mode-toggle" class:on={kitchen.preferences.dark}
				></span></button
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
	</aside>
	<main>
		<header class="topbar">
			<button
				class="icon-button mobile-menu"
				onclick={() => (mobileNav = !mobileNav)}
				aria-label="Toggle navigation"><Menu size={22} /></button
			>
			<div class="breadcrumb">
				<b>{nav.find((n) => n.id === page)?.name || 'Discover'}</b>
			</div>
			<div class="topbar-actions">
				<button
					class="icon-button"
					aria-label="Switch color mode"
					onclick={() => (kitchen.preferences.dark = !kitchen.preferences.dark)}
					>{#if kitchen.preferences.dark}<Sun size={18} />{:else}<Moon size={18} />{/if}</button
				><button class="top-avatar" onclick={() => (user ? household() : openAuthentication())}
					>{user?.name.slice(0, 1) || 'Y'}</button
				>
			</div>
		</header>
		<div class="main-content">
			{#if user}<SyncStatus
					{kitchen}
					{online}
					pending={pendingSync}
					syncing={sendingSync}
					{conflicts}
					error={syncErrors}
					retry={() => {
						void reconnectKitchen();
					}}
					resolve={(choice) => {
						void retrySync(choice);
					}}
					exportPending={exportPendingChanges}
				/>{/if}
			{#if showStarter}<div class="starter-note">
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
							><span class="heading-spark">✴</span>
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
						<button class="secondary" onclick={() => (modal = 'pantry')}
							><Plus size={18} />Ingredients</button
						>
						<button
							class="secondary"
							aria-label="Scan ingredients from a photo"
							onclick={() => imageInput.click()}><Camera size={19} /></button
						>
						<button class="secondary" aria-label="Dictate ingredients" onclick={dictate}
							><Mic size={19} /></button
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
								<button class="cream-button" onclick={() => (modal = 'pantry')}
									><Plus size={17} /> Add your ingredients <ArrowRight size={17} /></button
								><button
									class="banner-icon"
									aria-label="Scan ingredients from a photo"
									onclick={() => imageInput.click()}><Camera size={20} /></button
								><button class="banner-icon" aria-label="Dictate ingredients" onclick={dictate}
									><Mic size={20} /></button
								>
							</div>
						</div>
						<div class="banner-visual">
							<img
								src="https://images.unsplash.com/photo-1540420773420-3366772f4999?auto=format&fit=crop&w=800&q=85"
								alt="A colorful bowl of fresh vegetables and greens"
							/><span class="visual-spark">✳</span>
						</div>
					</section>{/if}
				<section class="recipe-section">
					<div class="section-heading">
						<div>
							<h2>
								{page === 'saved' ? 'Saved recipes' : 'Recipe ideas'}<span class="small-spark"
									>✷</span
								>
							</h2>
						</div>
						<div class="recipe-actions">
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
						<div class="filter-tabs">
							{#each ['For you', 'Quick & easy', 'Plant-powered', 'Comfort food', 'High protein'] as item}<button
									class:active={filter === item}
									aria-pressed={filter === item}
									onclick={() => (filter = item)}
									>{#if item === 'For you'}<Sparkles size={14} />{/if}{item}</button
								>{/each}
						</div>
						<div class="search-box">
							<Search size={17} /><input
								aria-label="Search recipes"
								placeholder="Search recipes"
								bind:value={query}
							/>
						</div>
					</div>
					<div class="recipe-grid">
						{#each recipes as recipe, i (recipe.id)}<article
								class="recipe-card"
								animate:flip={{ duration: motionDuration(250) }}
								in:revealMotion|global={{ y: 20, duration: 400, delay: Math.min(i * 65, 350) }}
							>
								<div class="recipe-image">
									<button
										class="image-open"
										onclick={() => (selected = recipe)}
										aria-label={`Open ${recipe.title}`}
										><img
											src={recipe.image || '/recipe-placeholder.svg'}
											alt={recipe.title}
											loading={i > 2 ? 'lazy' : 'eager'}
										/></button
									><span class="recipe-badge">{recipe.tags[0] || recipe.cuisine}</span><button
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
									<button class="recipe-title" onclick={() => (selected = recipe)}
										>{recipe.title}<ArrowUpRight size={18} /></button
									>
									<p>{recipe.description}</p>
									<div class="recipe-meta">
										<span><Clock size={14} />{recipe.time} min</span><span
											><ChefHat size={14} />{recipe.difficulty}</span
										><span class="pantry-match"
											><Leaf size={13} />{recipe.ingredients.filter((i) =>
												kitchen.pantry.some(
													(p) =>
														i.name.toLowerCase().includes(p.name.toLowerCase()) ||
														p.name.toLowerCase().includes(i.name.toLowerCase())
												)
											).length} in your pantry</span
										>
									</div>
								</div>
							</article>{/each}
					</div>
					{#if !recipes.length}<div class="empty-state">
							<Heart size={36} />
							<h3>
								{page === 'saved' ? 'No saved recipes yet' : 'No recipes found'}
							</h3>
							<p>
								{page === 'saved'
									? 'Tap the bookmark on any recipe to keep it close.'
									: 'Try another search or generate recipes.'}
							</p>
						</div>{/if}<button
						class="browse-link"
						onclick={() => {
							modal = 'search';
							error = '';
						}}>Find recipes online <ArrowUpRight size={16} /></button
					>
				</section>
			{:else if page === 'pantry'}
				<section class="page-heading" in:revealMotion|global={{ y: 12, duration: 300 }}>
					<div>
						<h1>Your pantry<span class="heading-spark">✳</span></h1>
						<p>Track ingredients and quantities you have on hand.</p>
					</div>
					<button class="primary" onclick={() => (modal = 'pantry')}
						><Plus size={18} /> Add ingredients</button
					>
				</section>
				<div class="pantry-summary">
					<span><b>{kitchen.pantry.length}</b> ingredients</span>
					<div>
						<button class="secondary" onclick={() => imageInput.click()}
							><Camera size={17} /> Scan a photo</button
						><button class="secondary" onclick={dictate}
							><Mic size={17} /> Tell us what you have</button
						>
					</div>
				</div>
				<div class="expiry-filters" aria-label="Filter pantry by expiry">
					{#each [{ id: 'all', label: 'All ingredients', count: kitchen.pantry.length }, { id: 'soon', label: 'Expiring soon', count: kitchen.pantry.filter((item) => expiryStatus(item.expires) === 'soon').length }, { id: 'expired', label: 'Expired', count: kitchen.pantry.filter((item) => expiryStatus(item.expires) === 'expired').length }] as option}<button
							class:active={pantryFilter === option.id}
							aria-pressed={pantryFilter === option.id}
							onclick={() => (pantryFilter = option.id)}
							>{option.label}<span>{option.count}</span></button
						>{/each}
				</div>
				<div class="pantry-table">
					<div class="table-head">
						<span>INGREDIENT</span><span>AMOUNT</span><span>BEST BEFORE</span><span></span>
					</div>
					{#each visiblePantry as item (item.id)}{@const expiry = expiryStatus(item.expires)}
						<div
							class="pantry-row"
							animate:flip={{ duration: motionDuration(200) }}
							in:revealMotion|global={{ y: 8, duration: 200 }}
							out:fadeMotion={{ duration: 120 }}
						>
							<span class="pantry-ingredient">
								<span class="ingredient-symbol">{ingredientEmoji(item.name)}</span><span
									class="ingredient-meta"
									><b>{item.name}</b><small
										class="expiry-badge"
										class:expired={expiry === 'expired'}
										class:soon={expiry === 'soon'}
										>{expiry === 'expired'
											? 'Expired'
											: expiry === 'soon'
												? 'Use soon'
												: expiry === 'fresh'
													? 'In date'
													: 'No date'}</small
									>{#if expiry === 'soon'}<button
											class="text-button use-first"
											onclick={() => useFirstIngredients([item])}
											><Sparkles size={14} />Use first</button
										>{/if}</span
								>
							</span><label
								><input
									aria-label={`Quantity of ${item.name}`}
									type="number"
									min="0"
									step="0.25"
									bind:value={item.quantity}
								/><input
									class="unit-input"
									aria-label={`Unit for ${item.name}`}
									bind:value={item.unit}
								/></label
							><input
								aria-label={`Expiry for ${item.name}`}
								type="date"
								bind:value={item.expires}
							/><button
								class="icon-button"
								aria-label={`Remove ${item.name}`}
								onclick={() => (kitchen.pantry = kitchen.pantry.filter((p) => p.id !== item.id))}
								><X size={16} /></button
							>
						</div>{/each}
				</div>
				{#if !kitchen.pantry.length}<div class="empty-state">
						<Carrot size={40} />
						<h3>No ingredients yet</h3>
						<p>Add a few things from your fridge to get started.</p>
					</div>{:else if !visiblePantry.length}<div class="empty-state filtered-pantry-empty">
						<Carrot size={34} />
						<h3>No matching ingredients</h3>
						<p>Try another expiry filter or update a best-before date.</p>
					</div>{/if}
				<div class="pantry-footer">
					<button class="primary" onclick={() => (modal = 'generate')}
						><Sparkles size={17} /> Cook from my pantry</button
					>
				</div>
			{:else if page === 'planner'}
				<section class="page-heading" in:revealMotion|global={{ y: 12, duration: 300 }}>
					<div>
						<h1>Meal planner<span class="heading-spark">✷</span></h1>
						<p>Schedule meals and build your weekly shopping list.</p>
					</div>
					<button
						class="primary"
						onclick={() => {
							selected = null;
							modal = 'pickRecipe';
						}}><Plus size={17} /> Plan a meal</button
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
						><button class="text-button" onclick={() => (weekOffset = 0)}>This week</button>
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
						class="calendar-grid"
						in:revealMotion|global={{ y: 8, duration: 220 }}
					>
						{#each week as day}<div
								class:today={dateKey(day) === dateKey(new Date())}
								class="calendar-day"
							>
								<div class="day-heading">
									<span>{day.toLocaleDateString('en', { weekday: 'short' })}</span><b
										>{day.getDate()}</b
									>
								</div>
								{#each ['Breakfast', 'Lunch', 'Dinner'] as slot}<div class="meal-slot">
										<span class="meal-label">{slot}</span
										>{#each kitchen.meals.filter((m) => m.date === dateKey(day) && m.slot === slot) as meal}{@const recipe =
												kitchen.recipes.find((r) => r.id === meal.recipeId)}{#if recipe}<div
													class="calendar-meal"
												>
													<button class="meal-open" onclick={() => (selected = recipe)}
														><img src={recipe.image || '/recipe-placeholder.svg'} alt="" /><b
															>{recipe.title}</b
														><small>{recipe.time} min · {meal.servings} servings</small></button
													>
													<div class="calendar-meal-actions">
														{#if meal.completedAt}<small class="cooked-badge"
																>Cooked {new Date(meal.completedAt).toLocaleDateString('en', {
																	month: 'short',
																	day: 'numeric'
																})}</small
															>{:else}<button
																class="text-button"
																onclick={() => editPlannedMeal(meal)}>Edit</button
															><button class="text-button" onclick={() => openCookDialog(meal)}
																>Cooked</button
															>{/if}
														<button
															class="remove-meal"
															aria-label="Remove planned meal"
															onclick={() => {
																const startDate = weekStartForDate(meal.date);
																kitchen.meals = kitchen.meals.filter((m) => m.id !== meal.id);
																refreshWeekShopping(startDate);
															}}><X size={13} /></button
														>
													</div>
												</div>{/if}{/each}<button
											class="add-meal"
											onclick={() => {
												mealDate = dateKey(day);
												mealSlot = slot;
												modal = 'pickRecipe';
											}}
											aria-label={`Plan ${slot} for ${day.toDateString()}`}
											><Plus size={17} /></button
										>
									</div>{/each}
							</div>{/each}
					</div>{/key}
				<section class="cooked-history">
					<div class="section-line">
						<h2>Cooked history</h2>
						<span class="muted"
							>{kitchen.meals.filter((meal) => meal.completedAt).length} meals</span
						>
					</div>
					{#if kitchen.meals.some((meal) => meal.completedAt)}<div class="cooked-history-list">
							{#each kitchen.meals
								.filter((meal) => meal.completedAt)
								.sort( (a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '') ) as meal (meal.id)}{@const recipe =
									kitchen.recipes.find((item) => item.id === meal.recipeId)}{#if recipe}<article
										class="cooked-history-row"
									>
										<img src={recipe.image || '/recipe-placeholder.svg'} alt="" />
										<div>
											<b>{recipe.title}</b><span
												>{new Date(meal.completedAt!).toLocaleDateString('en', {
													weekday: 'short',
													month: 'short',
													day: 'numeric'
												})} · {meal.servings} servings{meal.leftoverServings
													? ` · ${meal.leftoverServings} leftover`
													: ''}</span
											>
										</div>
										<div class="cooked-history-actions">
											{#if meal.leftoverServings}<button
													class="text-button"
													onclick={() => {
														meal.leftoverServings = 0;
														notify('Leftovers marked used.');
													}}>Use leftovers <Check size={15} /></button
												>{/if}<button class="text-button" onclick={() => (selected = recipe)}
												>{recipe.rating ? 'View rating' : 'Rate recipe'} <Star size={15} /></button
											>
										</div>
									</article>{/if}{/each}
						</div>{:else}<p class="muted history-empty">
							Meals marked cooked will appear here. You can add leftovers and update pantry stock
							when you finish a meal.
						</p>{/if}
				</section>
			{:else if page === 'shopping'}
				<section class="page-heading" in:revealMotion|global={{ y: 12, duration: 300 }}>
					<div>
						<h1>Shopping list<span class="heading-spark">✴</span></h1>
						<p>
							Generated rows show their recipe or meal-plan source. Editing a row keeps your changes
							visible until that source is refreshed.
						</p>
					</div>
					<button class="secondary" onclick={exportList}><Download size={17} /> Export list</button>
				</section>
				<div class="shopping-layout">
					<div>
						<div class="section-line">
							<h2>Items to buy</h2>
							<span class="muted"
								>{kitchen.shopping.filter((i) => i.checked).length} of {kitchen.shopping.length} purchased</span
							>
						</div>
						<div class="shopping-progress">
							<span
								style={`width:${kitchen.shopping.length ? (kitchen.shopping.filter((i) => i.checked).length / kitchen.shopping.length) * 100 : 0}%`}
							></span>
						</div>
						{#each kitchen.shopping as item (item.id)}<div
								class:checked={item.checked}
								class="shopping-row"
								animate:flip={{ duration: motionDuration(200) }}
								in:revealMotion|global={{ y: 8, duration: 200 }}
								out:fadeMotion={{ duration: 120 }}
							>
								<button
									class="check-box"
									class:checked={item.checked}
									aria-label={`Mark ${item.name} ${item.checked ? 'needed' : 'purchased'}`}
									onclick={() => (item.checked = !item.checked)}
									>{#if item.checked}<Check size={16} />{/if}</button
								>
								<div class="shopping-item-edit">
									<input
										class="shopping-name"
										aria-label="Shopping item name"
										bind:value={item.name}
										maxlength="100"
										onblur={() => normalizeShoppingItem(item)}
									/><small class="shopping-source">{shoppingSourceLabel(item.sourceKey)}</small>
								</div>
								<span class="shopping-quantity"
									><input
										aria-label={`Quantity of ${item.name}`}
										type="number"
										min="0.01"
										max="1000000"
										step="0.01"
										bind:value={item.quantity}
										onblur={() => normalizeShoppingItem(item)}
									/><input
										aria-label={`Unit for ${item.name}`}
										bind:value={item.unit}
										maxlength="40"
										onblur={() => normalizeShoppingItem(item)}
									/></span
								><button
									class="icon-button"
									aria-label={`Remove ${item.name}`}
									onclick={() =>
										(kitchen.shopping = kitchen.shopping.filter((i) => i.id !== item.id))}
									><X size={15} /></button
								>
							</div>{/each}{#if !kitchen.shopping.length}<div class="empty-state">
								<ShoppingBasket size={40} />
								<h3>Your shopping list is empty</h3>
								<p>Add a recipe or shop your meal plan to make a list.</p>
								<button class="secondary" onclick={() => navigate('discover')}
									>Browse recipes <ArrowRight size={16} /></button
								>
							</div>{/if}
						<form
							class="inline-add"
							onsubmit={(e) => {
								e.preventDefault();
								if (shoppingText.trim()) {
									kitchen.shopping.push({
										id: crypto.randomUUID(),
										name: shoppingText.trim(),
										quantity: 1,
										unit: 'piece',
										checked: false
									});
									shoppingText = '';
								}
							}}
						>
							<Plus size={18} /><input
								aria-label="Add shopping item"
								placeholder="Anything else for the basket?"
								bind:value={shoppingText}
							/><button class="text-button">Add</button>
						</form>
						<button
							class="text-button"
							onclick={() => {
								const checked = kitchen.shopping.filter((i) => i.checked);
								for (const item of checked) {
									const found = kitchen.pantry.find(
										(p) => p.name.toLowerCase() === item.name.toLowerCase() && p.unit === item.unit
									);
									if (found) found.quantity += item.quantity;
									else
										kitchen.pantry.push({
											id: crypto.randomUUID(),
											name: item.name,
											quantity: item.quantity,
											unit: item.unit,
											category: 'Pantry'
										});
								}
								kitchen.shopping = kitchen.shopping.filter((i) => !i.checked);
								notify(`${checked.length} purchased items moved to your pantry.`);
							}}>Put purchased items in my pantry <ArrowRight size={16} /></button
						>
					</div>
				</div>
			{/if}
		</div>
	</main>
</div>
{#if toast}<div
		class="toast"
		role="status"
		transition:revealMotion|global={{ y: 25, duration: 250 }}
	>
		<span>✳</span>{toast}<button onclick={() => (toast = '')} aria-label="Dismiss notification"
			><X size={16} /></button
		>
	</div>{/if}
{#if selected && !modal}<RecipeDetail
		recipe={selected}
		close={() => (selected = null)}
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
		{busy}
		rate={(n) => {
			selected!.rating = n;
			kitchen.preferences.ratings = { ...(kitchen.preferences.ratings ?? {}), [selected!.id]: n };
			kitchen.recipes = [...kitchen.recipes];
			notify('Rating saved. Future recipes will use your feedback.');
		}}
	/>{/if}
{#if editingRecipe}<RecipeEditor
		recipe={editingRecipe}
		cancel={() => (editingRecipe = null)}
		save={saveEditedRecipe}
	/>{/if}
{#if modal}<div class="modal-backdrop" transition:backdropMotion|global>
		{#key modal}
			<div
				class="flavor-dialog"
				class:onboarding-dialog={modal === 'onboarding'}
				use:focusTrap
				class:wide={modal === 'settings' ||
					modal === 'pickRecipe' ||
					modal === 'import' ||
					modal === 'editMeal' ||
					modal === 'cookMeal'}
				class:capture-dialog={modal === 'import'}
				role="dialog"
				aria-labelledby={modal === 'import' ? 'recipe-import-title' : undefined}
				aria-modal="true"
				aria-label={modal === 'onboarding'
					? 'Recipe preferences'
					: modal === 'import'
						? 'Import recipe'
						: modal}
				tabindex="-1"
				transition:dialogMotion|global
			>
				<button
					class="icon-button dialog-close"
					onclick={() => {
						closeDialog();
					}}
					aria-label="Close dialog"><X size={21} /></button
				>
				{#if modal === 'import'}<RecipeImport
						bind:session={importSession}
						capture={captureImport}
						save={saveImportedRecipe}
						dictate={dictateRecipe}
					/>{:else if modal === 'onboarding'}
					<span class="dialog-spark">✷</span>
					<h2>Recipe preferences</h2>
					<p class="muted onboarding-intro">
						Optional. Change these preferences anytime in Settings.
					</p>
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
									><option value="vegan">Vegan</option><option value="pescatarian"
										>Pescatarian</option
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
							<button class="primary" type="submit">Save preferences <Check size={17} /></button
							><button class="text-button" type="button" onclick={dismissOnboarding}
								>Maybe later</button
							>
						</div>
					</form>
				{:else if modal === 'pantry'}<span class="dialog-spark">✳</span>
					<h2>Add ingredients</h2>

					<label class="field"
						>Ingredients<textarea
							bind:value={pantryInput}
							placeholder={'Tomatoes, spinach, 200 g pasta, 2 eggs…'}
							rows="5"></textarea></label
					>
					<p class="field-help">
						Separate with commas or new lines. Add quantities and units when you know them.
					</p>
					<div class="dialog-actions">
						<button class="secondary" onclick={dictate}><Mic size={17} /> Use voice</button><button
							class="secondary"
							onclick={() => imageInput.click()}
							disabled={busy}><Camera size={17} /> Use photo</button
						><button class="primary" disabled={!pantryInput.trim()} onclick={addIngredients}
							>Add ingredients <ArrowRight size={17} /></button
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
						{#if authMode === 'login'}<button
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
						<div class="theme-grid">
							{#each themes as theme}<button
									class:active={kitchen.preferences.theme === theme}
									onclick={() => (kitchen.preferences.theme = theme)}
									>{theme}{#if kitchen.preferences.theme === theme}<Check size={13} />{/if}</button
								>{/each}
						</div>
						<button
							class="secondary"
							onclick={() => (kitchen.preferences.dark = !kitchen.preferences.dark)}
							>{#if kitchen.preferences.dark}<Sun size={16} />{:else}<Moon size={16} />{/if}Switch
							to {kitchen.preferences.dark ? 'light' : 'dark'} mode</button
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
											Email delivery is unavailable. Set RESEND_API_KEY and EMAIL_FROM to enable it.
										</p>{/if}{/if}
							{/if}
						</div>{/if}
					<div class="settings-section">
						<h3>Web recipe search</h3>
						{#if capabilities.recipeSearch}<p class="muted">
								Available for this installation.
							</p>{:else}<p class="muted">
								Unavailable. Set BRAVE_SEARCH_API_KEY on this installation to enable search.
							</p>{/if}
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
							companion={chatGPTCompanion}
							onselect={(id) => changeConnection(id)}
							onaccount={() => changeConnection()}
							onconnect={connectChatGPT}
							ondisconnect={disconnectChatGPT}
							onrefresh={refreshAISettings}
							onsignin={openAuthentication}
							ondownload={downloadChatGPTCompanion}
							onimport={importChatGPTConnection}
						/>
					</div>

					{#if user}<div class="settings-section">
							<h3>Your data</h3>
							<p class="muted">
								{managedAuth
									? 'Export your account and shared kitchen.'
									: 'Export your account and shared kitchen, or permanently remove your account.'}
							</p>
							<div class="dialog-actions">
								<button class="secondary" onclick={exportKitchen}
									><Download size={16} /> Export my data</button
								>{#if !managedAuth}<button
										class="text-button danger"
										onclick={() => {
											modal = 'delete';
											error = '';
										}}>Delete account</button
									>{/if}
							</div>
						</div>{/if}{#if error}<p class="error" role="alert">{error}</p>{/if}
					<div class="dialog-actions">
						{#if user && (!managedAuth || providerLogoutUrl)}<button
								class="text-button"
								onclick={logout}><LogOut size={16} /> Sign out</button
							>{:else if user && managedAuth}<span class="field-help"
								>Sign-out is managed by your access proxy.</span
							>{:else if !user && !managedAuth}<button
								class="text-button"
								onclick={openAuthentication}>Create an account</button
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
								<span class="profile-avatar"
									>{member.name.trim().charAt(0).toUpperCase() || '•'}</span
								>
								<div class="member-copy">
									<b>{member.name}{member.id === user?.id ? ' · You' : ''}</b><span
										>{member.email}</span
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
					<button class="secondary full" disabled={householdBusy || !joinCode.trim()} onclick={join}
						>Join household <ArrowRight size={17} /></button
					>
					{#if error}<p class="error" role="alert">{error}</p>{/if}
					<button
						class="text-button danger full"
						disabled={householdBusy}
						onclick={() => {
							modal = 'leave';
							error = '';
						}}>Leave this household</button
					>
				{:else if modal === 'removeMember'}
					<h2>Remove household member?</h2>
					<p class="muted">
						{memberToRemove?.name} will lose access to this shared kitchen. Their account will remain
						active.
					</p>
					{#if error}<p class="error" role="alert">{error}</p>{/if}
					<div class="dialog-actions">
						<button
							class="secondary"
							disabled={householdBusy}
							onclick={() => {
								memberToRemove = null;
								modal = 'household';
							}}>Keep member</button
						><button
							class="primary danger-action"
							disabled={householdBusy}
							onclick={confirmRemoveMember}>{householdBusy ? 'Removing…' : 'Remove member'}</button
						>
					</div>
				{:else if modal === 'leave'}
					<h2>Leave this household?</h2>
					<p class="muted">
						Leaving gives you a new personal kitchen. The shared pantry and recipes stay with your
						household. You can rejoin with a new invitation.
					</p>
					{#if error}<p class="error" role="alert">{error}</p>{/if}<button
						class="primary full"
						onclick={leaveHousehold}
						disabled={busy}>Leave household</button
					>
				{:else if modal === 'delete' && !managedAuth}
					<h2>Delete your account?</h2>
					<p class="muted">
						This permanently deletes your account, preferences, and sessions. Your shared kitchen
						remains for other members; a household with no members is deleted. This cannot be
						undone.
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
				{:else if (modal === 'recover' || modal === 'reset') && !managedAuth}<span
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
						<button class="primary danger-action" onclick={confirmDeleteRecipe}
							>Delete recipe</button
						>
					</div>
				{:else if modal === 'editMeal'}
					<h2>Edit planned meal</h2>
					<p class="muted">
						Update this meal in place. Its calendar entry keeps the same identity.
					</p>
					<label class="field"
						>When are we cooking?<input type="date" required bind:value={mealDate} /></label
					>
					<label class="field"
						>Meal<select bind:value={mealSlot}
							><option>Breakfast</option><option>Lunch</option><option>Dinner</option></select
						></label
					>
					<label class="field"
						>Servings<input
							type="number"
							min="1"
							max="24"
							step="1"
							required
							bind:value={plannedServings}
						/></label
					>
					<div class="dialog-actions">
						<button class="secondary" onclick={closeDialog}>Cancel</button><button
							class="primary"
							disabled={!mealDate || !plannedServings || plannedServings < 1}
							onclick={saveMealChanges}>Save meal</button
						>
					</div>
				{:else if modal === 'cookMeal'}
					{@const cookingMeal = kitchen.meals.find((meal) => meal.id === cookingMealId)}
					{@const cookingRecipe = kitchen.recipes.find(
						(recipe) => recipe.id === cookingMeal?.recipeId
					)}
					<h2>Mark meal cooked</h2>
					<p class="muted">{cookingRecipe?.title}</p>
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
							max={cookingMeal?.servings ?? 24}
							step="1"
							bind:value={leftoverServings}
						/><small class="field-help">Enter 0 if there are no leftovers.</small></label
					>
					<div class="dialog-actions">
						<button class="secondary" onclick={closeDialog}>Cancel</button><button
							class="primary"
							onclick={markMealCooked}><Check size={17} /> Mark cooked</button
						>
					</div>
				{:else if modal === 'plan'}
					<h2>Schedule a recipe</h2>
					<p class="muted">{selected?.title}</p>
					<label class="field"
						>When are we cooking?<input type="date" required bind:value={mealDate} /></label
					><label class="field"
						>Meal<select bind:value={mealSlot}
							><option>Breakfast</option><option>Lunch</option><option>Dinner</option></select
						></label
					><label class="field"
						>Servings<input type="number" min="1" max="24" bind:value={plannedServings} /></label
					><button
						class="primary full"
						disabled={!mealDate || !plannedServings || plannedServings < 1}
						onclick={addMeal}><CalendarDays size={17} /> Put it on the calendar</button
					>
				{:else if modal === 'pickRecipe'}
					<h2>Choose a recipe</h2>
					<div class="pick-list">
						{#each kitchen.recipes as recipe}<button
								onclick={() => {
									selected = recipe;
									plannedServings = recipe.servings;
									if (!mealDate) mealDate = dateKey(new Date());
									modal = 'plan';
								}}
								><img src={recipe.image || '/recipe-placeholder.svg'} alt="" /><span
									><b>{recipe.title}</b><small>{recipe.time} min · {recipe.cuisine}</small></span
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
					<p class="muted">
						Search real recipes across the web, with links to the original creators.
					</p>
					{#if !capabilities.recipeSearch}<p class="field-help">
							Web search is unavailable. Set BRAVE_SEARCH_API_KEY on this installation.
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
			</div>
		{/key}
	</div>{/if}

<style>
	.expiry-filters {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		margin: 20px 0 10px;
	}
	.expiry-filters button {
		min-height: 44px;
		display: inline-flex;
		align-items: center;
		gap: 9px;
		padding: 8px 12px;
		border: 1px solid var(--line);
		background: var(--surface);
		font-size: 14px;
	}
	.expiry-filters button.active {
		background: var(--green);
		color: var(--paper);
		border-color: var(--green);
	}
	.expiry-filters button span {
		min-width: 22px;
		padding: 2px 5px;
		background: color-mix(in srgb, currentColor 12%, transparent);
		text-align: center;
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
	.expiry-badge {
		font-size: 12px;
		color: var(--muted);
	}
	.expiry-badge.expired {
		color: #a43f36;
		font-weight: 600;
	}
	.expiry-badge.soon {
		color: #926b17;
		font-weight: 600;
	}
	.use-first {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		min-height: 34px;
		padding: 3px 0;
		font-size: 13px;
	}
	.filtered-pantry-empty {
		padding: 32px 12px;
	}
	.shopping-item-edit {
		min-width: 100px;
		flex: 1 1 180px;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.shopping-name {
		width: 100%;
		min-width: 0;
		padding: 8px 5px;
		border-color: transparent;
		background: transparent;
		font-weight: 500;
	}
	.shopping-name:focus {
		border-color: var(--line);
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
		width: 72px;
		padding: 8px 5px;
		border-color: transparent;
		background: transparent;
		text-align: right;
		font-size: 14px;
	}
	.shopping-quantity input:last-child {
		width: 70px;
		text-align: left;
	}
	.shopping-quantity input:focus {
		border-color: var(--line);
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
	.cook-option {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		margin: 22px 0;
		font-size: 14px;
	}
	.cook-option input {
		width: 20px;
		height: 20px;
		flex: 0 0 20px;
		margin-top: 2px;
		accent-color: var(--green);
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
	.danger-action {
		background: #a43f36;
		color: white;
	}
	.dialog-actions .danger-action:hover {
		background: #87332c;
	}
	@media (max-width: 650px) {
		.expiry-filters {
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
		.expiry-filters button {
			justify-content: center;
			gap: 5px;
			padding-inline: 6px;
			font-size: 12px;
		}
		.shopping-row {
			flex-wrap: wrap;
			align-items: center;
		}
		.shopping-item-edit {
			flex-basis: calc(100% - 66px);
			order: 2;
		}
		.shopping-quantity {
			order: 3;
			flex: 1 1 auto;
			margin-left: 44px !important;
		}
		.shopping-row > .icon-button {
			order: 4;
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
	.member-role {
		padding: 4px 7px;
		background: var(--wash);
		color: var(--muted);
		font-size: 12px;
	}
	.member-role.owner-role {
		background: var(--accent);
		color: var(--ink);
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
</style>
