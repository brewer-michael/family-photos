<!--
	Album name / when / about fields (new album, and editing by its creator or the admin).
	The inputs use defaultValue, not value: hydrating a `value` would wipe anything typed before the
	page hydrated. Both actions redirect on success, so enhance's form reset never shows a stale
	default. (Svelte's SSR doesn't render a textarea's defaultValue, so that one keeps `value`.)
-->
<script lang="ts">
	import { enhance } from '$app/forms';
	import Icon from './Icon.svelte';

	interface Props {
		/** Form action, e.g. "?/edit"; default: the page's default action. */
		action?: string;
		title?: string | null;
		whenText?: string | null;
		description?: string | null;
		submitLabel: string;
		/** Validation error from the action. */
		error?: { message: string; field?: string } | null;
		/** Shows a Cancel link back to this address. */
		cancelHref?: string;
	}

	let { action, title, whenText, description, submitLabel, error, cancelHref }: Props = $props();
	const idPrefix = $props.id();
	const invalid = (field: string) => error?.field === field;
</script>

<form method="POST" {action} use:enhance class="album-form">
	<div class="field">
		<label for="{idPrefix}-title">Album name</label>
		<input
			id="{idPrefix}-title"
			class="input"
			name="title"
			required
			maxlength="200"
			autocomplete="off"
			defaultValue={title ?? ''}
			aria-invalid={invalid('title')}
			aria-describedby="{idPrefix}-title-hint"
		/>
		<p id="{idPrefix}-title-hint" class="hint">For example "Summer at the lake" or "Grandpa's 80th".</p>
	</div>
	<div class="field">
		<label for="{idPrefix}-when">When (if you like)</label>
		<input
			id="{idPrefix}-when"
			class="input"
			name="whenText"
			maxlength="200"
			autocomplete="off"
			defaultValue={whenText ?? ''}
			aria-invalid={invalid('whenText')}
			aria-describedby="{idPrefix}-when-hint"
		/>
		<p id="{idPrefix}-when-hint" class="hint">For example "July 2024".</p>
	</div>
	<div class="field">
		<label for="{idPrefix}-about">About this album (if you like)</label>
		<textarea
			id="{idPrefix}-about"
			class="textarea"
			name="description"
			maxlength="5000"
			value={description ?? ''}
			aria-invalid={invalid('description')}
		></textarea>
	</div>
	{#if error}<p class="error" role="alert">{error.message}</p>{/if}
	<div class="actions">
		<button type="submit" class="btn btn-primary"><Icon name="check" /> {submitLabel}</button>
		{#if cancelHref}
			<a class="btn" href={cancelHref}><Icon name="close" /> Cancel</a>
		{/if}
	</div>
</form>

<style>
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
	}
</style>
