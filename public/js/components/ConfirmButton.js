// A destructive action's second click, as a `.small-btn` that arms itself instead of a dialog.
// First click swaps the label and turns it red, second within ARM_MS emits `confirm`; the timeout,
// a blur, or unmounting all disarm it. See CLAUDE.md for why it isn't window.confirm.
const ARM_MS = 4000;

export default {
  name: 'ConfirmButton',
  props: {
    label: { type: String, required: true },
    // Short enough not to resize the button much - it sits in a header row that already wraps.
    confirmLabel: { type: String, default: 'Sure?' },
    hint: { type: String, default: '' },
  },
  emits: ['confirm'],
  data() {
    return { armed: false };
  },
  created() {
    this._timer = null;
  },
  // The timer outlives the component otherwise: the Activity tab is v-if, so switching away mid-arm
  // would leave it to fire against a component that no longer exists.
  beforeUnmount() {
    this.disarm();
  },
  methods: {
    onClick() {
      if (this.armed) {
        this.disarm();
        this.$emit('confirm');
        return;
      }
      this.armed = true;
      this._timer = setTimeout(this.disarm, ARM_MS);
    },
    disarm() {
      this.armed = false;
      clearTimeout(this._timer);
      this._timer = null;
    },
  },
  template: `
    <button
      class="small-btn confirm-btn"
      :class="{ armed }"
      :title="armed ? 'Click again to confirm, or click away to cancel' : hint"
      @click="onClick"
      @blur="disarm"
    >{{ armed ? confirmLabel : label }}</button>
  `,
};
