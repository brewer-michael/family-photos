<!--
	"Ask to remove": nobody can delete, but anyone can ask the admin (docs/PLAN.md "Removal
	requests"). One pending request per device per item; posts to the page's ?/askRemove action.
	On a small phone the sheet scrolls, so "Send request" and "Cancel" stay stuck to its bottom.
-->
<script lang="ts">
	import { enhance } from '$app/forms';
	import Icon from './Icon.svelte';
	import { REMOVAL_REASONS, REMOVAL_REASON_LABELS, type RemovalReason } from '#lib/shared/media-types';

	interface Props {
		/** "photo" or "video". */
		kindWord: string;
		adminName: string;
		/** This device already has a pending request for the item. */
		alreadyAsked: boolean;
		/** The ?/askRemove result: sent, or an error message. */
		result?: { sent?: boolean; error?: string } | null;
	}

	let { kindWord, adminName, alreadyAsked, result }: Props = $props();

	let dialog = $state<HTMLDialogElement>();
	let reason = $state<RemovalReason | ''>('');
	let details = $state('');
	let localError = $state('');
	let sending = $state(false);
	const error = $derived(localError || result?.error || '');
	const reassurance = $derived(`Nothing is deleted yet — ${adminName} will look at it.`);

	function open() {
		localError = '';
		if (dialog && !dialog.open) dialog.showModal();
	}
	function close() {
		dialog?.close();
	}
</script>

<button type="button" class="btn" onclick={open} aria-haspopup="dialog">
	{#if alreadyAsked}
		<Icon name="check" /> You already asked
	{:else}
		<Icon name="flag" /> Ask to remove
	{/if}
</button>

<dialog class="sheet" bind:this={dialog} aria-labelledby="remove-title">
	{#if result?.sent || alreadyAsked}
		<h2 id="remove-title">{result?.sent ? 'Thank you' : 'You already asked'}</h2>
		<p role="status">
			{result?.sent ? `We've passed your request on.` : `You've already asked for this ${kindWord} to be removed.`}
			{reassurance}
		</p>
		<button type="button" class="btn btn-primary btn-block" onclick={close}>
			<Icon name="check" /> OK
		</button>
	{:else}
		<h2 id="remove-title">Ask to remove this {kindWord}</h2>
		<!-- Checked here (and on the server) so the message is ours, in big friendly words. -->
		<form
			method="POST"
			action="?/askRemove"
			novalidate
			use:enhance={({ cancel }) => {
				if (!reason) {
					localError = 'Please pick a reason.';
					return cancel();
				}
				if (reason === 'other' && !details.trim()) {
					localError = 'Please tell us a little about why.';
					return cancel();
				}
				localError = '';
				sending = true;
				return async ({ update }) => {
					try {
						await update({ reset: false });
					} finally {
						sending = false;
					}
				};
			}}
		>
			<fieldset>
				<legend class="label">Why should it be removed?</legend>
				<div class="chips">
					{#each REMOVAL_REASONS as r (r)}
						<label class="chip">
							<input type="radio" name="reason" value={r} bind:group={reason} />
							<span>{REMOVAL_REASON_LABELS[r]}</span>
						</label>
					{/each}
				</div>
			</fieldset>
			<div class="field">
				<label for="remove-details">
					Tell {adminName} more {reason === 'other' ? '(please do)' : '(if you like)'}
				</label>
				<textarea
					id="remove-details"
					class="textarea details"
					class:roomy={reason === 'other'}
					name="details"
					maxlength="2000"
					aria-required={reason === 'other'}
					aria-describedby={error ? 'remove-error' : undefined}
					aria-invalid={!!error && reason === 'other' && !details.trim()}
					bind:value={details}
				></textarea>
			</div>
			{#if error}<p id="remove-error" class="error" role="alert">{error}</p>{/if}
			<p class="notice">{reassurance}</p>
			<div class="actions">
				<button type="submit" class="btn btn-primary" disabled={sending}>
					<Icon name="flag" /> Send request
				</button>
				<button type="button" class="btn" onclick={close}>
					<Icon name="close" /> Cancel
				</button>
			</div>
		</form>
	{/if}
</dialog>

<style>
	fieldset {
		border: 0;
		margin: 0 0 1rem;
		padding: 0;
	}
	legend {
		margin-bottom: 0.5rem;
	}
	.chips {
		display: grid;
		gap: 0.5rem;
	}
	.chip {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-height: var(--tap);
		padding: 0.5rem 1rem;
		border: 2px solid var(--border);
		border-radius: var(--radius);
		cursor: pointer;
		font-weight: 600;
	}
	.chip:has(input:checked) {
		border-color: var(--primary);
		background: var(--surface-2);
		box-shadow: inset 0 0 0 1px var(--primary);
	}
	.chip:has(input:focus-visible) {
		outline: 3px solid var(--focus);
		outline-offset: 3px;
	}
	.chip input {
		width: 1.4rem;
		height: 1.4rem;
		margin: 0;
		accent-color: var(--primary);
		flex: none;
	}
	.chip input:focus-visible {
		outline: none;
		box-shadow: none;
	}
	/* Smaller until "Something else" asks for words. */
	.details {
		min-height: 5rem;
	}
	.details.roomy {
		min-height: 7.5rem;
	}
	/* Always in view at the bottom of the sheet, over the sheet's own bottom padding. */
	.actions {
		position: sticky;
		bottom: -1.5rem;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 10rem), 1fr));
		gap: 0.75rem;
		margin: 0 0 -1.5rem;
		padding: 0.75rem 0 1.5rem;
		background: var(--surface);
		border-top: 1px solid var(--line);
	}
</style>
