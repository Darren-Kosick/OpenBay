import { esc } from '../util.js';
import { checkAccount, parseCard, parseVehicle } from '../validate.js';
import { cardFields, field, vehicleFields } from './ui.js';

const DEMO = {
  name: 'Demo Driver',
  email: 'demo@openbay.test',
  password: 'demo-password',
  vehicle: { plate: 'CDXR418', province: 'ON', make: 'Honda', model: 'Civic', colour: 'Grey' },
  card: { brand: 'Visa', last4: '4242', expiry: '12/30', holder: 'Demo Driver' },
};

export const login = {
  public: true,

  render(ctx) {
    return `<section class="auth card stack">
      <div class="auth-head">
        <div class="logo" aria-hidden="true">P</div>
        <h1>Sign in</h1>
        <p class="muted" style="margin-top:6px">Reserve a spot before you get to the lot.</p>
      </div>
      ${ctx.error()}
      <form data-form="login" class="stack" novalidate>
        ${field('Email', 'email', 'type="email" autocomplete="username" required')}
        ${field('Password', 'password', 'type="password" autocomplete="current-password" required')}
        <button class="btn primary block" type="submit">Sign in</button>
      </form>
      <div class="row between">
        <button class="btn ghost" data-act="start-signup">Create an account</button>
        <button class="btn ghost" data-act="demo">Use demo account</button>
      </div>
    </section>`;
  },

  forms: {
    async login(ctx, data) {
      ctx.state.user = await ctx.api.login(data.email, data.password);
      await ctx.go('find');
    },
  },

  actions: {
    'start-signup': (ctx) => ctx.go('signup', { signup: { step: 1, data: {} } }),

    async demo(ctx) {
      try {
        ctx.state.user = await ctx.api.login(DEMO.email, DEMO.password);
      } catch (error) {
        if (error.status !== 401) throw error;
        ctx.state.user = await ctx.api.register(DEMO);      // first time on this server
      }
      await ctx.go('find');
    },
  },
};

const TITLES = ['Create your account', 'Register your vehicle', 'Add a payment method'];

export const signup = {
  public: true,

  load(ctx) {
    ctx.state.signup ??= { step: 1, data: {} };
  },

  render(ctx) {
    const { step, data } = ctx.state.signup;
    const body =
      step === 1
        ? `${field('Full name', 'name', `autocomplete="name" required value="${esc(data.name || '')}"`)}
           ${field('Email', 'email', `type="email" autocomplete="email" required value="${esc(data.email || '')}"`)}
           ${field('Phone', 'phone', `type="tel" autocomplete="tel" value="${esc(data.phone || '')}"`, 'Optional. For reservation reminders.')}
           ${field('Password', 'password', 'type="password" autocomplete="new-password" required', 'At least 8 characters.')}`
        : step === 2
          ? vehicleFields(data.vehicle)
          : cardFields();

    return `<section class="auth card stack">
      <ol class="steps" aria-label="Step ${step} of 3">${[1, 2, 3].map((i) => `<li class="${i <= step ? 'on' : ''}"></li>`).join('')}</ol>
      <div><h1>${TITLES[step - 1]}</h1><p class="muted" style="margin-top:6px">Step ${step} of 3</p></div>
      ${ctx.error()}
      <form data-form="signup" class="stack" novalidate>
        ${body}
        <div class="row between">
          ${step === 1
            ? '<button type="button" class="btn ghost" data-act="nav" data-view="login">Back to sign in</button>'
            : '<button type="button" class="btn ghost" data-act="back">Back</button>'}
          <span class="row">
            ${step === 3 ? '<button type="button" class="btn" data-act="skip-card">Skip for now</button>' : ''}
            <button class="btn primary" type="submit">${step === 3 ? 'Create account' : 'Continue'}</button>
          </span>
        </div>
      </form>
    </section>`;
  },

  forms: {
    async signup(ctx, form) {
      // `form` is the submitted fields as a plain object.
      // A thrown error is shown inside the form by main.js, keeping what was typed.
      const s = ctx.state.signup;
      if (s.step === 1) {
        checkAccount(form);
        Object.assign(s.data, { name: form.name.trim(), email: form.email.trim(), phone: form.phone.trim(), password: form.password });
      } else if (s.step === 2) {
        s.data.vehicle = parseVehicle(form);
      } else {
        s.data.card = parseCard(form);
        await finish(ctx);
        return;
      }
      s.step += 1;
      ctx.state.err = '';
      ctx.render();
    },
  },

  actions: {
    back(ctx) {
      ctx.state.signup.step -= 1;
      ctx.state.err = '';
      ctx.render();
    },
    async 'skip-card'(ctx) {
      delete ctx.state.signup.data.card;
      await finish(ctx);
    },
  },
};

async function finish(ctx) {
  const s = ctx.state.signup;
  try {
    ctx.state.user = await ctx.api.register(s.data);
    ctx.state.signup = null;
    await ctx.go('find');
    ctx.toast(`Welcome, ${ctx.state.user.name.split(' ')[0]}.`);
  } catch (error) {
    if (/email/i.test(error.message)) s.step = 1;      // e.g. the email is already registered
    ctx.fail(error);
  }
}
