<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import type { PageProps } from './$types';
	import Icon from '#lib/components/Icon.svelte';
	import AdminIcon from '#lib/components/admin/AdminIcon.svelte';
	import AdminNav from '#lib/components/admin/AdminNav.svelte';
	import ConfirmAction from '#lib/components/admin/ConfirmAction.svelte';
	import Note from '#lib/components/admin/Note.svelte';
	import Thumb from '#lib/components/admin/Thumb.svelte';
	import { formatDay } from '#lib/client/format';

	let { data, form }: PageProps = $props();

	const left = (days: number) => (days === 0 ? 'Deleted for good today' : `Deleted for good in ${days} ${days === 1 ? 'day' : 'days'}`);

	/** Items being restored right now: their button is disabled, so a double tap does it once. */
	let busy = $state<Record<string, boolean>>({});
	const restoring =
		(id: string): SubmitFunction =>
		() => {
			busy[id] = true;
			return async ({ update }) => {
				try {
					await update();
				} finally {
					busy[id] = false;
				}
			};
		};
</script>

<svelte:head>
	<title>Trash · {data.siteTitle}</title>
</svelte:head>

<div class="page">
	<AdminNav />
	<h1>Trash</h1>
	<p>Items are removed for good after 30 days. Until then you can bring them back.</p>

	<Note result={form} />
	{#if form?.conflictId}
		<p><a class="tap" href="/view/{form.conflictId}">See the copy that is in the album</a></p>
	{/if}

	{#if data.items.length === 0}
		<p class="empty">The trash is empty.</p>
	{:else}
		<ul class="rows">
			{#each data.items as t (t.id)}
				<li class="row card">
					<Thumb src={t.thumbUrl} kind={t.kind} alt={t.name} />
					<div class="text">
						<p class="lead">
							{#if t.ready}<a class="tap" href="/view/{t.id}">{t.name}</a>{:else}<strong>{t.name}</strong>{/if}
						</p>
						<p>Added by {t.by}{t.album ? ` to “${t.album}”` : ''}</p>
						{#if t.reason}<p class="muted">{t.reason}</p>{/if}
						<p class="muted small">In the trash since {formatDay(t.trashedAt, data.timeZone)} · {left(t.daysLeft)}</p>
					</div>
					<form method="POST" action="?/restore" use:enhance={restoring(t.id)}>
						<input type="hidden" name="id" value={t.id} />
						<button type="submit" class="btn" disabled={busy[t.id]}>
							<AdminIcon name="undo" /> Restore<span class="visually-hidden">: {t.name}</span>
						</button>
					</form>
				</li>
			{/each}
		</ul>

		<div class="section">
			<ConfirmAction label="Empty trash now…" confirmLabel="Yes, delete them for good" action="?/empty">
				{#snippet icon()}<Icon name="trash" />{/snippet}
				<p>
					All {data.items.length} {data.items.length === 1 ? 'item' : 'items'} in the trash, and their files, are deleted for good. This
					can't be undone.
				</p>
			</ConfirmAction>
		</div>
	{/if}
</div>

<style>
	/* Links on their own get the same 56 px tap height as buttons. */
	.tap {
		display: inline-flex;
		align-items: center;
		min-height: var(--tap);
		max-width: 100%;
		overflow-wrap: anywhere;
	}
	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--gap);
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 1rem;
		padding: 1rem;
	}
	.text {
		flex: 1 1 14rem;
		min-width: 0;
	}
	.text p {
		margin: 0 0 0.3rem;
	}
	.lead {
		font-size: var(--fs-large);
		overflow-wrap: anywhere;
	}
	.small {
		font-size: var(--fs-small);
	}
</style>
