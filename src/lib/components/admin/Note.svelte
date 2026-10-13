<!--
	The outcome of an admin action, shown next to the controls that caused it. The live region is
	always there, so screen readers announce what appears in it.
-->
<script lang="ts">
	interface Props {
		result: { ok: boolean; message: string } | null | undefined;
	}

	let { result }: Props = $props();
</script>

<div class="note" aria-live="polite">
	{#if result}
		<p class="notice" class:bad={!result.ok} class:notice-ok={result.ok} role={result.ok ? 'status' : 'alert'}>
			{result.message}
		</p>
	{/if}
</div>

<style>
	.note:empty {
		display: none;
	}
	.notice {
		margin: 0.75rem 0;
	}
	.bad {
		border-left-color: var(--danger);
		color: var(--text);
		font-weight: 600;
	}
</style>
