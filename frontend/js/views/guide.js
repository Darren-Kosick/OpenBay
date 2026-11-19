// How it works: using the system, parking, what to do if your spot is taken, and the rules.

import { icon } from './ui.js';

const TOPICS = [
  {
    icon: 'sparkle',
    title: 'Getting started',
    intro: 'OpenBay shows which spots are free and lets you reserve one before you arrive.',
    steps: [
      'Create an account with your name, email and a password.',
      'Register your vehicle. The licence plate is how a reservation is matched to your car.',
      'Add a payment method. You are charged when you confirm a reservation.',
      'You can add more vehicles or change your card any time in the Profile tab.',
    ],
  },
  {
    icon: 'parking',
    title: 'Reserving a spot',
    intro: 'Everything starts in the Find tab.',
    steps: [
      'Tap Use my location. Lots are sorted by distance, and if you are already in a lot it is picked for you.',
      'Open a lot to see it in 3D. Blue spots are available, red are reserved, grey cars are parked vehicles.',
      'Tap a blue spot, then Hold this spot. It is locked for you for two minutes so nobody else can take it.',
      'Choose your vehicle and how long you need, then tap Confirm reservation.',
      'Your confirmation shows the spot, time and total. It is also saved in the Reservations tab.',
    ],
  },
  {
    icon: 'car',
    title: 'How to park',
    intro: 'A few habits keep the lot working for everyone.',
    steps: [
      'Drive to the row shown on your reservation. The letter is the row and the number is the spot, so B6 is row B, spot 6.',
      'Park only in the spot you reserved, even if a closer one looks empty. It may be held for someone else.',
      'Park inside the lines and pull fully into the spot so the aisle stays clear.',
      'Leave before your end time. If you need longer, make a new reservation before the current one runs out.',
      'Accessible spots need a valid permit. EV spots are for vehicles that are charging.',
    ],
  },
  {
    icon: 'warning',
    title: 'Someone is in your spot',
    intro: 'If another vehicle is in the spot you reserved, report it and you will be moved.',
    steps: [
      'Open the Reservations tab and find your active reservation.',
      'Tap Someone is in my spot.',
      "Add the other vehicle's licence plate if you can see it. This is optional.",
      'Tap Report and move me. Your reservation moves to the closest free spot in the same lot, or the nearest lot with space if this one is full.',
      'Your end time and price stay the same. If nothing is free anywhere, the reservation is cancelled and refunded.',
      'Do not confront the driver or block the vehicle in. The report goes to the lot operator.',
    ],
  },
  {
    icon: 'list',
    title: 'What counts as a violation',
    intro: 'These can be reported to the lot operator.',
    bullets: true,
    steps: [
      'Parking in a spot that someone else has reserved.',
      'Parking without a reservation in a managed lot.',
      'Staying past the end time of your reservation.',
      'Using an accessible spot without a permit, or an EV spot without charging.',
      'Parking across two spots or blocking an aisle.',
    ],
  },
];

export default {
  tab: 'guide',

  render() {
    return `<div class="stack">
      <h1>How it works</h1>
      ${TOPICS.map((t, i) => `<details class="card topic" ${i === 0 ? 'open' : ''}>
        <summary><span class="topic-icon">${icon(t.icon)}</span>${t.title}</summary>
        <div class="body">
          <p class="muted">${t.intro}</p>
          <${t.bullets ? 'ul' : 'ol'}>${t.steps.map((s) => `<li>${s}</li>`).join('')}</${t.bullets ? 'ul' : 'ol'}>
        </div>
      </details>`).join('')}
    </div>`;
  },
};
