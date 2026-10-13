<!--
	"Add to Home Screen" tip for phones, until it is dismissed or the site already runs from the
	Home Screen. iOS note: a Home Screen app has its own cookies, so the family code is asked once
	more. The dismissal is remembered in localStorage when the browser allows it.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from './Icon.svelte';
	import { detectPlatform, type Platform } from '#lib/client/save';

	interface Props {
		siteTitle: string;
	}

	let { siteTitle }: Props = $props();

	const STORAGE_KEY = 'fp-home-screen-tip-dismissed';

	interface InstallPromptEvent extends Event {
		prompt(): Promise<void>;
		userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
	}

	let show = $state(false);
	let platform = $state<Platform>('desktop');
	let installPrompt = $state<InstallPromptEvent | null>(null);

	onMount(() => {
		platform = detectPlatform();
		const standalone =
			matchMedia('(display-mode: standalone)').matches ||
			(navigator as Navigator & { standalone?: boolean }).standalone === true;
		let dismissed = false;
		try {
			dismissed = localStorage.getItem(STORAGE_KEY) === '1';
		} catch {
			// storage blocked (private mode): just show the tip
		}
		show = platform !== 'desktop' && !standalone && !dismissed;

		const onPrompt = (e: Event) => {
			e.preventDefault();
			installPrompt = e as InstallPromptEvent;
		};
		window.addEventListener('beforeinstallprompt', onPrompt);
		return () => window.removeEventListener('beforeinstallprompt', onPrompt);
	});

	function dismiss() {
		show = false;
		try {
			localStorage.setItem(STORAGE_KEY, '1');
		} catch {
			// not remembered; it shows again next time
		}
	}

	async function install() {
		if (!installPrompt) return;
		await installPrompt.prompt();
		const { outcome } = await installPrompt.userChoice;
		installPrompt = null;
		if (outcome === 'accepted') dismiss();
	}
</script>

{#if show}
	<aside class="tip card" aria-labelledby="home-tip-title">
		<h2 id="home-tip-title"><Icon name="phone" /> Tip: put {siteTitle} on your Home Screen</h2>
		{#if platform === 'ios'}
			<p>
				In Safari, tap the <strong>Share</strong> button <Icon name="share" size="1.1em" /> and then
				<strong>Add to Home Screen</strong>.
			</p>
			<p class="hint">The first time you open it from your Home Screen, type the family code once more.</p>
		{:else if !installPrompt}
			<p>Open your browser's menu <strong>⋮</strong> and choose <strong>Add to Home screen</strong>.</p>
		{/if}
		<div class="actions">
			{#if installPrompt}
				<button type="button" class="btn btn-primary" onclick={install}><Icon name="plus" /> Add to Home Screen</button>
			{/if}
			<button type="button" class="btn" onclick={dismiss}><Icon name="check" /> Got it</button>
		</div>
	</aside>
{/if}

<style>
	.tip {
		margin-top: 1.5rem;
		padding: 1rem 1.1rem;
		border-left: 6px solid var(--accent);
	}
	h2 {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: var(--fs-large);
	}
	.hint {
		margin-bottom: 0.5rem;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
</style>
