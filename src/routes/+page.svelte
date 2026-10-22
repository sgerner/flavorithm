<script lang="ts">
	import { onMount } from 'svelte';
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
		Menu,
		RefreshCw
	} from '@lucide/svelte';
	import type { AppState, Recipe, User } from '#lib/types.ts';
	import { createInitialState, createNewUserState } from '#lib/data.ts';
	import { buildShoppingList, preferenceSummary } from '#lib/domain.ts';
	import RecipeDetail from '#lib/components/RecipeDetail.svelte';
	let kitchen = $state<AppState>(createInitialState());
	let user = $state<User | null>(null);
	let ready = $state(false);
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
	let pantryInput = $state('');
	let authMode = $state('register');
	let name = $state('');
	let email = $state('');
	let password = $state('');
	let error = $state('');
	let apiKey = $state('');
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
	let connectionPoll: ReturnType<typeof setInterval> | undefined;
	let connectionPopup: Window | null = null;
	let connectionPollCount = 0;
	let activeChatGPTAccount = $derived(
		chatGPT.accounts.find((a) => a.id === kitchen.preferences.chatgptAccountId)
	);

	let modelQuery = $state('');
	let providers = $state<
		{ id: string; name: string; models: { id: string; name: string; vision: boolean }[] }[]
	>([]);
	let prompt = $state('');
	let recipeUrl = $state('');
	let searchResults = $state<{ title: string; url: string; description: string }[]>([]);
	let members = $state<{ name: string; email: string }[]>([]);
	let inviteCode = $state('');
	let joinCode = $state('');
	let weekOffset = $state(0);
	let mealDate = $state('');
	let mealSlot = $state('Dinner');
	let plannedServings = $state(2);
	let shoppingText = $state('');
	let deletePassword = $state('');
	let resetToken = $state('');
	let showStarter = $state(true);
	let imageInput: HTMLInputElement;
	let deferredInstall = $state<any>(null);
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
	let recipes = $derived(
		kitchen.recipes
			.filter(
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
			)
			.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
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
	async function request(url: string, body?: unknown, method = 'POST') {
		const headers: Record<string, string> =
			body === undefined ? {} : { 'Content-Type': 'application/json' };
		if (url === '/api/state' && method === 'PUT') {
			if (stateEtag) headers['If-Match'] = stateEtag;
			else headers['If-None-Match'] = '*';
		}
		const response = await fetch(url, {
			method: body === undefined ? 'GET' : method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		const data = await response.json();
		if (!response.ok) {
			if (response.status === 412 || response.status === 428) {
				syncing = true;
				syncConflict = true;
				clearTimeout(saveTimer);
				notify(
					'Your household changed in another tab. Reload to pick up the latest kitchen before making more changes.'
				);
			}
			throw new Error(data.error || 'Something went wrong. Please try again.');
		}
		if (url === '/api/state') stateEtag = data.state ? response.headers.get('etag') : null;
		return data;
	}

	let syncing = $state(false);
	let syncConflict = $state(false);
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
		localStorage.setItem('flavorithm-kitchen', snapshot);
		clearTimeout(saveTimer);
		if (user && !syncing)
			saveTimer = setTimeout(() => {
				writeChain = writeChain
					.then(async () => {
						if (!syncing && user)
							await request('/api/state', { state: JSON.parse(snapshot) }, 'PUT');
					})
					.catch((e) => notify(`Could not sync: ${e.message}`));
			}, 500);
	});
	onMount(() => {
		try {
			const local = localStorage.getItem('flavorithm-kitchen');
			if (local) {
				kitchen = JSON.parse(local);
				if (!themes.includes(kitchen.preferences.theme)) kitchen.preferences.theme = 'nosh';
			}
		} catch {}
		showStarter = localStorage.getItem('flavorithm-started') !== 'yes';
		ready = true;
		const returnFromChatGPT = new URL(window.location.href).searchParams.has('chatgpt');
		const reset = new URL(window.location.href).searchParams.get('reset');
		if (returnFromChatGPT) {
			modal = 'settings';
			window.history.replaceState({}, '', window.location.pathname);
		}
		if (reset) {
			resetToken = reset;
			modal = 'reset';
			window.history.replaceState({}, '', window.location.pathname);
		}
		request('/api/auth')
			.then(async (data) => {
				syncing = true;
				if (data.user) {
					const saved = await request('/api/state');
					kitchen = saved.state || createNewUserState();
				}
				user = data.user;
				if (user) showStarter = false;
				syncing = false;
				if (user && returnFromChatGPT) await openSettings();
				if (user)
					await refreshConnections().catch(() =>
						notify('Your ChatGPT connection could not be checked. Open Settings to reconnect.')
					);
			})
			.catch(() => notify('Working locally. Account sync is unavailable.'));
		if ('serviceWorker' in navigator)
			navigator.serviceWorker.register('/service-worker.js').catch(() => {
				/* Offline installation is retried on the next visit. */
			});
		const install = (e: Event) => {
			e.preventDefault();
			deferredInstall = e;
		};
		window.addEventListener('beforeinstallprompt', install);
		return () => {
			window.removeEventListener('beforeinstallprompt', install);
			clearInterval(connectionPoll);
		};
	});
	async function loadLatestKitchen() {
		try {
			syncing = true;
			clearTimeout(saveTimer);
			await writeChain;
			const result = await request('/api/state');
			if (result.state) kitchen = result.state;
			syncConflict = false;
			syncing = false;
			notify('Your kitchen is up to date.');
		} catch (e) {
			notify((e as Error).message);
		}
	}
	async function flushKitchen() {
		clearTimeout(saveTimer);
		await writeChain;
		if (user && !syncConflict)
			await request('/api/state', { state: JSON.parse(JSON.stringify(kitchen)) }, 'PUT');
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
			const saved = await request('/api/state');
			if (saved.state) kitchen = saved.state;
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
			modal = '';
			notify(`Welcome to your kitchen, ${user?.name.split(' ')[0]}.`);
			if (authMode === 'register' && !kitchen.preferences.onboardingStatus) openOnboarding();
		} catch (e) {
			error = (e as Error).message;
		} finally {
			busy = false;
			syncing = false;
		}
	}
	async function logout() {
		try {
			syncing = true;
			clearTimeout(saveTimer);
			await flushKitchen();
			await request('/api/auth', { action: 'logout' });
			user = null;
			kitchen = createInitialState();
			localStorage.removeItem('flavorithm-kitchen');
			apiKey = '';
			clearInterval(connectionPoll);
			connectionBusy = false;
			chatGPT = { configured: false, mode: 'unavailable', accounts: [] };
			stateEtag = null;
			syncing = false;
			modal = '';
			notify('Signed out. Your household is safely saved.');
		} catch (e) {
			notify((e as Error).message);
		}
	}

	async function loadModelCatalog() {
		if (!user) return;
		if (kitchen.preferences.provider === 'chatgpt') {
			if (
				!kitchen.preferences.chatgptAccountId ||
				!activeChatGPTAccount?.planEnabled ||
				!activeChatGPTAccount?.connected
			) {
				providers = [];
				return;
			}
			providers = (
				await request(
					`/api/models?connection=chatgpt&accountId=${encodeURIComponent(kitchen.preferences.chatgptAccountId)}`
				)
			).providers;
		} else providers = (await request('/api/models')).providers;
	}
	async function refreshConnections() {
		if (!user) return;
		chatGPT = await request('/api/connections/chatgpt');
		if (!chatGPT.accounts.some((a) => a.id === kitchen.preferences.chatgptAccountId))
			kitchen.preferences.chatgptAccountId =
				chatGPT.accounts.find((a) => a.connected && a.planEnabled)?.id || chatGPT.accounts[0]?.id;
	}
	async function openSettings() {
		mobileNav = false;
		modal = 'settings';
		error = '';
		try {
			if (user) {
				await refreshConnections();
				await loadModelCatalog();
			}
		} catch (e) {
			error = (e as Error).message;
		}
	}
	async function changeConnection() {
		apiKey = '';
		kitchen.preferences.model = '';
		modelQuery = '';
		error = '';
		try {
			await refreshConnections();
			await loadModelCatalog();
		} catch (e) {
			error = (e as Error).message;
		}
	}
	async function connectChatGPT(accountId?: string, reconsent = false) {
		if (!user) {
			modal = 'auth';
			return;
		}
		connectionBusy = true;
		error = '';
		connectionPopup = window.open(
			'about:blank',
			'flavorithm-chatgpt-connect',
			'popup,width=620,height=780'
		);
		try {
			const previousAccounts = new Map(chatGPT.accounts.map((a) => [a.id, a.updatedAt]));
			const previous = JSON.stringify(chatGPT.accounts);
			const result = await request('/api/connections/chatgpt', {
				action: 'start',
				accountId,
				reconsent
			});
			if (connectionPopup) connectionPopup.location.href = result.authorizationUrl;
			else {
				window.location.assign(result.authorizationUrl);
				return;
			}
			clearInterval(connectionPoll);
			connectionPollCount = 0;
			let polling = false;
			connectionPoll = setInterval(async () => {
				if (polling) return;
				polling = true;
				try {
					await refreshConnections();
					connectionPollCount++;
					const connectionChanged = JSON.stringify(chatGPT.accounts) !== previous;
					if (connectionChanged || connectionPopup?.closed) {
						clearInterval(connectionPoll);
						connectionBusy = false;
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
						error = 'The connection window timed out. Try connecting again.';
					}
				} catch (e) {
					clearInterval(connectionPoll);
					connectionBusy = false;
					error = (e as Error).message;
				} finally {
					polling = false;
				}
			}, 1500);
		} catch (e) {
			connectionPopup?.close();
			connectionBusy = false;
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
			providers = [];
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
		}
	}
	function needAI() {
		if (!user) {
			modal = 'auth';
			notify('Create an account to use your AI connection.');
			return false;
		}
		const isPlan = kitchen.preferences.provider === 'chatgpt';
		if (
			(isPlan ? !activeChatGPTAccount?.connected || !activeChatGPTAccount.planEnabled : !apiKey) ||
			!kitchen.preferences.model
		) {
			openSettings();
			notify(
				isPlan
					? 'Connect your ChatGPT plan and choose an available model.'
					: 'Connect a model in Settings to generate recipes.'
			);
			return false;
		}
		return true;
	}
	async function ai(action: string, extra: Record<string, unknown> = {}) {
		return request('/api/ai', {
			action,
			...(kitchen.preferences.provider === 'chatgpt'
				? { connectionId: kitchen.preferences.chatgptAccountId }
				: { apiKey }),
			provider: kitchen.preferences.provider,
			model: kitchen.preferences.model,
			pantry: kitchen.pantry,
			preferences: kitchen.preferences,
			recipes: kitchen.recipes.filter((r) => r.rating),
			prompt,
			...extra
		});
	}
	async function generate() {
		if (!needAI()) return;
		busy = true;
		error = '';
		try {
			const result = await ai('generate');
			kitchen.recipes = [...result.recipes, ...kitchen.recipes];
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
		const Recognition =
			(window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
		if (!Recognition) {
			notify('Voice input is unavailable in this browser. Try Chrome or type your ingredients.');
			return;
		}
		const recognition = new Recognition();
		recognition.lang = navigator.language;
		recognition.interimResults = false;
		recognition.onresult = (e: any) => {
			pantryInput += (pantryInput ? ', ' : '') + e.results[0][0].transcript;
			modal = 'pantry';
			notify('Review your ingredients, then add them.');
		};
		recognition.onerror = () => notify('Microphone access failed. Check browser permissions.');
		recognition.start();
		notify('Listening… tell us what’s in your kitchen.');
	}
	function saveRecipe(r: Recipe) {
		r.saved = !r.saved;
		kitchen.recipes = [...kitchen.recipes];
		notify(r.saved ? 'Saved to your collection.' : 'Removed from your collection.');
	}
	function shoppingFor(items: Recipe[], meals?: AppState['meals']) {
		const additions = buildShoppingList(items, kitchen.pantry, meals);
		for (const item of additions) {
			const existing = kitchen.shopping.find(
				(i) => i.name.toLowerCase() === item.name.toLowerCase() && i.unit === item.unit
			);
			if (existing) existing.quantity += item.quantity;
			else kitchen.shopping.push(item);
		}
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
	function addMeal() {
		if (!selected || !mealDate) return;
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
	async function household() {
		mobileNav = false;
		if (!user) {
			modal = 'auth';
			return;
		}
		modal = 'household';
		error = '';
		try {
			members = (await request('/api/household')).members;
		} catch (e) {
			error = (e as Error).message;
		}
	}
	async function invite() {
		try {
			inviteCode = (await request('/api/household', { action: 'createInvite' })).inviteCode;
			notify('Invite ready. Share it with someone you cook with.');
		} catch (e) {
			error = (e as Error).message;
		}
	}
	async function join() {
		try {
			syncing = true;
			clearTimeout(saveTimer);
			await flushKitchen();
			const result = await request('/api/household', { action: 'join', code: joinCode });
			members = result.members;
			const data = await request('/api/state');
			kitchen = data.state || createNewUserState();
			joinCode = '';
			syncing = false;
			notify('Welcome to your shared kitchen.');
		} catch (e) {
			syncing = false;
			error = (e as Error).message;
		}
	}
	async function refreshNutrition() {
		if (!selected || !needAI()) return;
		busy = true;
		try {
			const result = await ai('nutrition', { recipe: selected });
			selected.nutrition = result.nutrition;
			kitchen.recipes = [...kitchen.recipes];
			notify('Nutrition estimate refreshed, per serving.');
		} catch (e) {
			notify((e as Error).message);
		} finally {
			busy = false;
		}
	}
	async function importRecipe(url: string) {
		if (!needAI()) return;
		busy = true;
		error = '';
		try {
			const result = await ai('import', { url });
			kitchen.recipes = [...result.recipes, ...kitchen.recipes];
			modal = '';
			selected = result.recipes[0];
			notify('Recipe imported, with credit to its original creator.');
		} catch (e) {
			error = (e as Error).message;
		} finally {
			busy = false;
		}
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
		busy = true;
		error = '';
		try {
			syncing = true;
			clearTimeout(saveTimer);
			await writeChain;
			await request('/api/auth', { action: 'deleteAccount', password: deletePassword });
			user = null;
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
	async function recover(event: SubmitEvent) {
		event.preventDefault();
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
		error = '';
		try {
			syncing = true;
			clearTimeout(saveTimer);
			await flushKitchen();
			await request('/api/household', { action: 'leave' });
			const data = await request('/api/state');
			kitchen = data.state || createNewUserState();
			syncing = false;
			modal = '';
			notify('You now have your own kitchen.');
		} catch (e) {
			syncing = false;
			error = (e as Error).message;
		} finally {
			busy = false;
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
		if (!user) {
			modal = 'auth';
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
			if (modal === 'onboarding') dismissOnboarding();
			else modal = '';
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
<div class="app-shell" inert={!!modal || !!selected}>
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
			><button onclick={openSettings}><Settings size={18} /> Settings & themes</button><button
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
		<button class="profile-button" onclick={() => (user ? openSettings() : (modal = 'auth'))}
			><span class="profile-avatar">{user ? user.name.slice(0, 1).toUpperCase() : 'Y'}</span><span
				><b>{user?.name || 'Sign in'}</b><small
					>{user ? 'Account settings' : 'Save your pantry and recipes'}</small
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
				><button class="top-avatar" onclick={() => (user ? household() : (modal = 'auth'))}
					>{user?.name.slice(0, 1) || 'Y'}</button
				>
			</div>
		</header>
		<div class="main-content">
			{#if syncConflict}<div class="sync-notice" role="alert">
					<div>
						<b>Your household has fresh changes.</b>
						<p>
							Your local edits are preserved on this device. Export them before loading the latest
							kitchen.
						</p>
					</div>
					<button
						class="secondary"
						onclick={() =>
							download(
								JSON.stringify(kitchen, null, 2),
								'flavorithm-local-changes.json',
								'application/json'
							)}>Export local edits</button
					><button class="primary" onclick={loadLatestKitchen}>Load latest kitchen</button>
				</div>{/if}
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
						<button
							class="primary"
							onclick={() => {
								modal = 'generate';
								error = '';
							}}><Sparkles size={17} /> Generate recipes</button
						>
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
				<div class="pantry-table">
					<div class="table-head">
						<span>INGREDIENT</span><span>AMOUNT</span><span>BEST BEFORE</span><span></span>
					</div>
					{#each kitchen.pantry as item (item.id)}<div
							class="pantry-row"
							animate:flip={{ duration: motionDuration(200) }}
							in:revealMotion|global={{ y: 8, duration: 200 }}
							out:fadeMotion={{ duration: 120 }}
						>
							<span
								><span class="ingredient-symbol">{ingredientEmoji(item.name)}</span><b
									>{item.name}</b
								></span
							><label
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
							const meals = kitchen.meals.filter((m) => week.some((d) => dateKey(d) === m.date));
							if (!meals.length) {
								notify('Plan a meal first to build your weekly shopping list.');
								return;
							}
							shoppingFor(
								kitchen.recipes.filter((r) => meals.some((m) => m.recipeId === r.id)),
								meals
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
													<button onclick={() => (selected = recipe)}
														><img src={recipe.image || '/recipe-placeholder.svg'} alt="" /><b
															>{recipe.title}</b
														><small>{recipe.time} min · {meal.servings} servings</small></button
													><button
														class="remove-meal"
														aria-label="Remove planned meal"
														onclick={() =>
															(kitchen.meals = kitchen.meals.filter((m) => m.id !== meal.id))}
														><X size={13} /></button
													>
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
			{:else if page === 'shopping'}
				<section class="page-heading" in:revealMotion|global={{ y: 12, duration: 300 }}>
					<div>
						<h1>Shopping list<span class="heading-spark">✴</span></h1>
						<p>Pantry quantities are deducted from recipe shopping lists.</p>
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
								><b>{item.name}</b><span>{+item.quantity.toFixed(2)} {item.unit}</span><button
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
										kitchen.pantry.push({ ...item, id: crypto.randomUUID(), category: 'Pantry' });
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
				[{ id: crypto.randomUUID(), recipeId: selected!.id, date: '', slot: '', servings }]
			)}
		plan={(servings) => planRecipe(selected!, servings)}
		nutrition={refreshNutrition}
		{busy}
		rate={(n) => {
			selected!.rating = n;
			kitchen.recipes = [...kitchen.recipes];
			notify('Rating saved. Future recipes will use your feedback.');
		}}
	/>{/if}
{#if modal}<div class="modal-backdrop" transition:backdropMotion|global>
		{#key modal}
			<div
				class="flavor-dialog"
				class:onboarding-dialog={modal === 'onboarding'}
				use:focusTrap
				class:wide={modal === 'settings' || modal === 'pickRecipe'}
				role="dialog"
				aria-modal="true"
				aria-label={modal === 'onboarding' ? 'Recipe preferences' : modal}
				tabindex="-1"
				transition:dialogMotion|global
			>
				<button
					class="icon-button dialog-close"
					onclick={() => {
						if (modal === 'plan') selected = null;
						if (modal === 'onboarding') dismissOnboarding();
						else modal = '';
						error = '';
					}}
					aria-label="Close dialog"><X size={21} /></button
				>
				{#if modal === 'onboarding'}
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
									? 'Sign in'
									: 'Come on in'}<ArrowRight size={17} /></button
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
					<div class="settings-section intelligence-settings">
						<h3>AI connection</h3>
						<p class="muted">Connect a model for recipe generation, photos, and nutrition.</p>
						{#if !user}<p class="field-help">
								Sign in to link your ChatGPT plan or use your own API key.
							</p>
							<button class="secondary" onclick={() => (modal = 'auth')}>Sign in to connect</button
							>{/if}
						<div class="two-fields">
							<label class="field"
								>Connection<select
									bind:value={kitchen.preferences.provider}
									onchange={changeConnection}
									><option value="chatgpt">ChatGPT subscription</option><option value="openai"
										>OpenAI API key</option
									><option value="anthropic">Anthropic API key</option><option value="openrouter"
										>OpenRouter API key</option
									></select
								></label
							><label class="field"
								>Search models<input
									bind:value={modelQuery}
									placeholder={kitchen.preferences.provider === 'chatgpt'
										? 'Your account’s models…'
										: 'Search models.dev…'}
								/></label
							>
						</div>
						{#if kitchen.preferences.provider === 'chatgpt'}
							<div class="subscription-connection">
								<div class="section-line">
									<h3>Cook with your ChatGPT plan</h3>
									<span
										class="connection-status"
										class:connected={activeChatGPTAccount?.connected &&
											activeChatGPTAccount?.planEnabled}
										>{activeChatGPTAccount?.connected
											? activeChatGPTAccount.planEnabled
												? 'Plan enabled'
												: 'Sign-in only'
											: 'Not connected'}</span
									>
								</div>
								<p class="muted">
									Authorize Flavorithm with ChatGPT. Eligible requests use your plan allowance and
									app limits, without an API key.
								</p>
								{#if chatGPT.accounts.length}<label class="field"
										>ChatGPT account<select
											bind:value={kitchen.preferences.chatgptAccountId}
											onchange={changeConnection}
											>{#each chatGPT.accounts as account}<option value={account.id}
													>{account.label}{account.connected
														? ''
														: ' · reconnect'}{account.planEnabled ? '' : ' · plan disabled'}</option
												>{/each}</select
										></label
									>{/if}
								{#if chatGPT.configured}<div class="connection-actions">
										<button
											class="primary"
											disabled={connectionBusy || !user}
											onclick={() => connectChatGPT(activeChatGPTAccount?.id)}
											>{connectionBusy
												? 'Waiting for ChatGPT…'
												: activeChatGPTAccount
													? 'Reconnect with ChatGPT'
													: 'Continue with ChatGPT'}<ArrowUpRight size={16} /></button
										>{#if chatGPT.accounts.length}<button
												class="secondary"
												disabled={connectionBusy}
												onclick={() => connectChatGPT()}>Add another account</button
											>{/if}{#if activeChatGPTAccount?.connected && !activeChatGPTAccount.planEnabled}<button
												class="secondary"
												disabled={connectionBusy}
												onclick={() => connectChatGPT(activeChatGPTAccount?.id, true)}
												>Enable plan usage</button
											>{/if}
									</div>{:else}<p class="field-help">
										{chatGPT.safeReason ||
											'Sign in to see the connection options for this installation.'}
									</p>{/if}
								{#if chatGPT.mode === 'local'}<p class="field-help">
										Connect from a browser on the computer running Flavorithm. OpenAI’s local-app
										flow returns to a temporary 127.0.0.1 callback.
									</p>{/if}
								{#if activeChatGPTAccount?.connected}<div class="connection-actions">
										<a
											class="text-button"
											href="https://chatgpt.com/settings/usage"
											target="_blank"
											rel="noreferrer">Manage usage in ChatGPT <ArrowUpRight size={14} /></a
										><button
											class="text-button danger"
											disabled={connectionBusy}
											onclick={disconnectChatGPT}>Disconnect account</button
										>
									</div>{/if}
								<p class="field-help">
									Plan availability and weekly app limits are managed by ChatGPT. Flavorithm will
									not switch to API-key billing automatically. Your ChatGPT conversations and
									memories are not imported.
								</p>
							</div>
						{:else}
							<label class="field"
								>API key<input
									type="password"
									autocomplete="off"
									placeholder="Your provider API key"
									bind:value={apiKey}
								/></label
							>
							<p class="field-help">
								API keys stay in memory for this tab. Requests use the selected provider’s API
								billing. Image scanning needs a model that supports images.
							</p>
							{#if kitchen.preferences.provider === 'anthropic'}<p class="provider-note">
									Claude subscription access through third-party products requires Anthropic
									approval. This connection uses the supported Console API key flow. <a
										href="https://code.claude.com/docs/en/agent-sdk/overview"
										target="_blank"
										rel="noreferrer">Read the current requirements <ArrowUpRight size={13} /></a
									>
								</p>{/if}
						{/if}
						<label class="field"
							>Model<select bind:value={kitchen.preferences.model}
								><option value="">Select a model</option
								>{#each (providers.find((p) => p.id === kitchen.preferences.provider)?.models || []).filter( (m) => `${m.name} ${m.id}`
											.toLowerCase()
											.includes(modelQuery.toLowerCase()) ) as model}<option value={model.id}
										>{model.name}{model.vision ? ' · image input' : ''}</option
									>{/each}</select
							></label
						>
						{#if kitchen.preferences.provider === 'chatgpt' && activeChatGPTAccount?.connected && activeChatGPTAccount.planEnabled}<button
								class="text-button"
								onclick={() => loadModelCatalog().catch((e) => (error = e.message))}
								><RefreshCw size={14} /> Refresh account model catalog</button
							>{/if}
						<label class="field"
							>Default cooking complexity<select bind:value={kitchen.preferences.complexity}
								><option>Easy</option><option>Moderate</option><option>Adventurous</option></select
							></label
						>
					</div>

					{#if user}<div class="settings-section">
							<h3>Your data</h3>
							<p class="muted">
								Export your account and shared kitchen, or permanently remove your account.
							</p>
							<div class="dialog-actions">
								<button class="secondary" onclick={exportKitchen}
									><Download size={16} /> Export my data</button
								><button
									class="text-button danger"
									onclick={() => {
										modal = 'delete';
										error = '';
									}}>Delete account</button
								>
							</div>
						</div>{/if}{#if error}<p class="error" role="alert">{error}</p>{/if}
					<div class="dialog-actions">
						{#if user}<button class="text-button" onclick={logout}
								><LogOut size={16} /> Sign out</button
							>{:else}<button class="text-button" onclick={() => (modal = 'auth')}
								>Create an account</button
							>{/if}{#if deferredInstall}<button
								class="secondary"
								onclick={() => deferredInstall.prompt()}>Install app</button
							>{/if}<button
							class="primary"
							onclick={() => {
								modal = '';
								notify('Preferences saved.');
							}}>Looking good <Check size={17} /></button
						>
					</div>
				{:else if modal === 'household'}<span class="dialog-spark">✳</span>
					<h2>Your household</h2>
					<p class="muted">
						A shared pantry, recipe collection, meal plan, and shopping list for the people you cook
						with.
					</p>
					{#each members as member}<div class="member-row">
							<span class="profile-avatar">{member.name[0]}</span>
							<div>
								<b>{member.name}</b>
								<p class="muted">{member.email}</p>
							</div>
						</div>{/each}<button class="primary full" onclick={invite}
						><Plus size={17} /> Invite someone to your kitchen</button
					>{#if inviteCode}<div class="invite-code">
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
						<p class="field-help">Share privately. Invitations expire and can be used once.</p>{/if}
					<hr />
					<h3>Have an invitation?</h3>
					<p class="field-help">Joining switches you to the invited household’s shared kitchen.</p>
					<label class="field"
						>Invite code<input
							bind:value={joinCode}
							placeholder="Paste your invitation code"
						/></label
					><button class="secondary full" disabled={!joinCode.trim()} onclick={join}
						>Join household <ArrowRight size={17} /></button
					>{#if error}<p class="error" role="alert">{error}</p>{/if}
					<button
						class="text-button danger full"
						onclick={() => {
							modal = 'leave';
							error = '';
						}}>Leave this household</button
					>
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
				{:else if modal === 'delete'}
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
				{:else if modal === 'recover' || modal === 'reset'}<span class="dialog-spark">✳</span>
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
					<label class="field"
						>What are you craving?<input
							bind:value={prompt}
							placeholder="Lemony weeknight pasta…"
						/></label
					><button class="primary full" disabled={busy} onclick={internetSearch}
						><Search size={17} />{busy ? 'Looking for something good…' : 'Search recipes'}</button
					>{#if error}<p class="error" role="alert">{error}</p>{/if}
					<hr />
					<h3>A recipe caught your eye?</h3>
					<label class="field"
						>Import its link<input
							type="url"
							bind:value={recipeUrl}
							placeholder="https://www.bbcgoodfood.com/recipes/…"
						/></label
					>
					<p class="field-help">
						Supports BBC Good Food, Serious Eats, Simply Recipes, Allrecipes, EatingWell, Love &
						Lemons, and Cookie + Kate when structured recipe data is available. Import uses your
						connected model.
					</p>
					<button
						class="secondary full"
						disabled={busy || !recipeUrl.trim()}
						onclick={() => importRecipe(recipeUrl)}
						><Plus size={16} /> Import from a recipe link</button
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
