<script lang="ts">
  import { fetchHealth } from './lib/api'

  let backend = $state<'checking' | 'ok' | 'down'>('checking')

  $effect(() => {
    fetchHealth()
      .then((h) => (backend = h.status === 'ok' ? 'ok' : 'down'))
      .catch(() => (backend = 'down'))
  })
</script>

<main>
  <h1>doc-digest</h1>
  <p>Read a PDF and ask questions about it, with the right context.</p>
  <p class="status" data-state={backend}>
    Backend:
    {#if backend === 'checking'}checking…{:else if backend === 'ok'}connected{:else}not reachable{/if}
  </p>
</main>

<style>
  main {
    max-width: 40rem;
    margin: 4rem auto;
    padding: 0 1rem;
  }
  .status[data-state='ok'] {
    color: #1a7f37;
  }
  .status[data-state='down'] {
    color: #cf222e;
  }
</style>
