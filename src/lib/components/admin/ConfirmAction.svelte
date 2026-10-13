<!--
	A button for something that can't be undone. The first tap only opens an explanation; the
	POST happens on the second ("Yes, …"), so nothing is done by accident or by a link.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { enhance } from '$app/forms';

	interface Props {
		/** Opens the confirmation, e.g. "Reset access…". */
		label: string;
		/** Does it, e.g. "Yes, reset access". */
		confirmLabel: string;
		/** Form action, e.g. "?/resetAccess". */
		action: string;
		/** Hidden form fields. */
		fields?: Record<string, string | number>;
		icon?: Snippet;
		/** What will happen, in plain words. */
		children: Snippet;
	}

	let { label, confirmLabel, action, fields = {}, icon, children }: Props = $props();

	let open = $state(false);
	let busy = $state(false);
</script>

<details class="confirm" bind:open>
	<summary class="btn btn-danger">{@render icon?.()} {label}</summary>
	<div class="body">
		{@render children()}
		<form
			method="POST"
			{action}
			use:enhance={() => {
				busy = true;
				return async ({ result, update }) => {
					try {
						await update();
						if (result.type === 'success') open = false;
					} finally {
						busy = false;
					}
				};
			}}
		>
			{#each Object.entries(fields) as [name, value] (name)}
				<input type="hidden" {name} {value} />
			{/each}
			<div class="actions">
				<button type="submit" class="btn btn-primary danger" disabled={busy}>{@render icon?.()} {confirmLabel}</button>
				<button type="button" class="btn" onclick={() => (open = false)}>Cancel</button>
			</div>
		</form>
	</div>
</details>

<style>
	summary {
		list-style: none;
		width: fit-content;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	.confirm[open] summary {
		background: var(--surface-2);
	}
	.body {
		margin-top: 0.75rem;
		padding: 1rem 1.1rem;
		border: 2px solid var(--danger);
		border-radius: var(--radius);
		background: var(--surface);
		max-width: var(--text-max);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
	}
	.danger {
		background: var(--danger);
		border-color: var(--danger);
		color: var(--on-primary);
	}
</style>
