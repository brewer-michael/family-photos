<!--
	"Save to my phone" (see #lib/client/save for the rules per device). Without JavaScript, and on
	Android and computers, it is a plain download link of the full-quality file.
-->
<script lang="ts">
	import Icon from './Icon.svelte';
	import type { Saver } from '#lib/client/saver.svelte';

	interface Props {
		saver: Saver;
		/** Called after the share sheet was used or the download started. */
		onsaved?: () => void;
		/** Extra classes for the button. */
		class?: string;
	}

	let { saver, onsaved, class: extra = '' }: Props = $props();
	const statusId = $props.id();

	const busy = $derived(saver.phase === 'preparing' && !saver.quiet);
	const tapToSave = $derived(saver.phase === 'ready' && !saver.quiet);

	async function onclick() {
		if (await saver.tap()) onsaved?.();
	}
</script>

{#if saver.mode === 'share'}
	<button type="button" class="btn btn-primary {extra}" aria-describedby={statusId} {onclick}>
		{#if busy}
			<span class="spinner" aria-hidden="true"></span>
			<span class="pct">Getting it ready… {saver.pct}%</span>
		{:else if tapToSave}
			<Icon name="save" /> Tap to save
		{:else if saver.phase === 'error'}
			<Icon name="retry" /> Try again
		{:else}
			<Icon name="save" /> Save to my phone
		{/if}
	</button>
{:else}
	<a class="btn btn-primary {extra}" href={saver.target.downloadUrl} download={saver.target.name} onclick={() => onsaved?.()}>
		<Icon name="save" /> Save to my phone
	</a>
{/if}
<span id={statusId} class="visually-hidden" role="status">{saver.message}</span>

<style>
	.pct {
		font-variant-numeric: tabular-nums;
	}
</style>
