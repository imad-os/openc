// Switch between the top-level screens.
const VIEWS = ['auth', 'connect', 'models', 'ws'];

export function show(name) {
  for (const v of VIEWS) document.getElementById('v-' + v).hidden = v !== name;
  document.body.dataset.view = name;
}
export const current = () => document.body.dataset.view;
