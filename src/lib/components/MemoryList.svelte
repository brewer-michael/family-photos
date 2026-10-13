<!--
	Memories on one item: the list (oldest first), "Write a memory", and edit/delete for the
	device that wrote one (the admin may delete any). Posts to the page's ?/addMemory,
	?/editMemory and ?/deleteMemory actions; editing is a link (?edit=<id>) so it works without JS.
-->
<script lang="ts">
	import { enhance } from '$app/forms';
	import Icon from './Icon.svelte';
	import type { MemoryDTO } from '#lib/client/dto';
	import { formatDay } from '#lib/client/format';

	interface Props {
		memories: MemoryDTO[];
		/** The memory being edited (from ?edit=). */
		editingId: number | null;
		/** Path of the viewer page without the query (Cancel goes back to it). */
		pagePath: string;
		kindWord: string;
		timeZone: string;
		/** Result of the last memory action. */
		result?: { saved?: boolean; deleted?: boolean; error?: string; errorFor?: 'add' | number; body?: string } | null;
	}

	let { memories, editingId, pagePath, kindWord, timeZone, result }: Props = $props();

	const addError = $derived(result?.errorFor === 'add' ? result.error : undefined);
</script>

<section class="memories" aria-labelledby="memories-title">
	<h2 id="memories-title"><Icon name="memory" /> Memories</h2>

	{#if result?.saved}
		<p class="notice notice-ok" role="status">Thank you — your memory is saved.</p>
	{:else if result?.deleted}
		<p class="notice" role="status">The memory was deleted.</p>
	{/if}

	{#if memories.length === 0}
		<p class="muted">No memories yet. What do you remember about this {kindWord}?</p>
	{:else}
		<ol class="list">
			{#each memories as m (m.id)}
				<li id="memory-{m.id}" class="memory card">
					{#if editingId === m.id && m.mine}
						<form method="POST" action="?/editMemory" use:enhance>
							<input type="hidden" name="id" value={m.id} />
							<div class="field">
								<label for="edit-{m.id}">Change your memory</label>
								<textarea
									id="edit-{m.id}"
									class="textarea"
									name="body"
									maxlength="5000"
									required
									aria-invalid={result?.errorFor === m.id}
									aria-describedby={result?.errorFor === m.id ? `edit-error-${m.id}` : undefined}
									value={result?.errorFor === m.id ? result.body : m.body}
								></textarea>
								{#if result?.errorFor === m.id}
									<p id="edit-error-{m.id}" class="error" role="alert">{result.error}</p>
								{/if}
							</div>
							<div class="actions">
								<button type="submit" class="btn btn-primary"><Icon name="check" /> Save changes</button>
								<a class="btn" href="{pagePath}#memory-{m.id}"><Icon name="close" /> Cancel</a>
							</div>
						</form>
					{:else}
						<p class="body">{m.body}</p>
						<p class="meta">
							— {m.authorName}, {formatDay(m.createdAt, timeZone)}{m.edited ? ' (edited)' : ''}
						</p>
						{#if m.mine || m.canDelete}
							<div class="actions">
								{#if m.mine}
									<a class="btn" href="?edit={m.id}#memory-{m.id}" data-sveltekit-noscroll>
										<Icon name="pencil" /> Edit
									</a>
								{/if}
								{#if m.canDelete}
									<form
										method="POST"
										action="?/deleteMemory"
										use:enhance={({ cancel }) => {
											if (!confirm('Delete this memory? This cannot be undone.')) cancel();
										}}
									>
										<input type="hidden" name="id" value={m.id} />
										<button type="submit" class="btn btn-danger">
											<Icon name="trash" /> Delete{m.mine ? '' : ` ${m.authorName}'s memory`}
										</button>
									</form>
								{/if}
							</div>
						{/if}
					{/if}
				</li>
			{/each}
		</ol>
	{/if}

	<form id="write-memory" class="write card" method="POST" action="?/addMemory" use:enhance>
		<div class="field">
			<label for="memory-body">Write a memory</label>
			<p id="memory-hint" class="hint">Who's in it? Where was it? What happened that day?</p>
			<textarea
				id="memory-body"
				class="textarea"
				name="body"
				maxlength="5000"
				required
				aria-invalid={!!addError}
				aria-describedby={addError ? 'memory-hint memory-error' : 'memory-hint'}
				value={addError ? result?.body : ''}
			></textarea>
			{#if addError}<p id="memory-error" class="error" role="alert">{addError}</p>{/if}
		</div>
		<button type="submit" class="btn btn-primary"><Icon name="memory" /> Save memory</button>
	</form>
</section>

<style>
	.memories {
		margin-top: 2rem;
		scroll-margin-top: 1rem;
	}
	h2 {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.list {
		list-style: none;
		margin: 0 0 1.5rem;
		padding: 0;
		display: grid;
		gap: 0.75rem;
	}
	.memory {
		padding: 1rem 1.1rem;
		scroll-margin-top: 1rem;
	}
	.body {
		white-space: pre-wrap;
		font-size: var(--fs-large);
		margin-bottom: 0.5rem;
	}
	.meta {
		color: var(--muted);
		margin-bottom: 0;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.75rem;
	}
	.actions form {
		display: contents;
	}
	.write {
		padding: 1rem 1.1rem 1.25rem;
		scroll-margin-top: 1rem;
	}
	.write label {
		font-size: var(--fs-large);
	}
</style>
