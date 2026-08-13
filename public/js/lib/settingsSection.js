// Shared save/clear/test lifecycle for a Settings tab: sets `saving`, clears `error`/`status`,
// runs fn, and reports the outcome via vm.error. Not pure (mutates the calling component), so it
// doesn't belong in the pure/unit-tested part of lib/ - it exists purely to avoid repeating this
// same try/catch/finally identically across SettingsWebhook/Thresholds/ContainerRules/Hosts.
export async function withStatus(vm, savingField, fn) {
  vm[savingField] = true;
  vm.error = null;
  vm.status = null;
  try {
    await fn();
  } catch (err) {
    vm.error = err.message;
  } finally {
    vm[savingField] = false;
  }
}
