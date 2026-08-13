<script lang="ts">
  const status = 'Initial project setup';
</script>

<main>
  <header>
    <h1>Vibext</h1>
    <p>Describe a change to make to this page.</p>
  </header>

  <label for="prompt">Prompt</label>
  <textarea
    id="prompt"
    name="prompt"
    placeholder="What would you like to change?"
    rows="5"
  ></textarea>

  <div class="actions">
    <button type="button">Select element</button>
    <button type="button">Send</button>
  </div>

  <p class="status">{status}</p>
</main>
