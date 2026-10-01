// business-config.js: MOCK CLIENT for testing the Shopify + Render setup.
// Fictional business, safe to demo.
export default {
  name: 'Brightside Plumbing',
  tagline: 'a family-owned plumbing company',
  city: 'Austin, TX',
  serviceArea: 'Austin, Round Rock, Cedar Park, and Pflugerville',

  phone: '(512) 555-0199',
  email: 'service@brightsideplumbing.example',
  address: '100 Example Street, Austin, TX 78701',
  licenseNumber: 'Master Plumber License #M-00000',
  inBusinessSince: '2012',

  hours: [
    'Monday-Friday: 8am-6pm',
    'Saturday: 9am-1pm',
    'Sunday: Emergency calls only',
  ],

  services: [
    'Drain cleaning (from $120)',
    'Leak detection and repair (from $150 diagnostic)',
    'Water heater repair and replacement (free estimate)',
    'Faucet and fixture installation (from $95)',
    'Repiping (free estimate)',
  ],

  maintenancePlan: {
    monthlyPrice: '$12/month',
    perks: ['annual inspection', '10% off repairs', 'priority scheduling'],
    singleVisitPrice: '$99',
  },

  extraNotes: [
    'Every job gets a written quote before work starts.',
  ],

  emergencyExamples: [
    'a burst pipe or active flooding',
    'a gas smell near a water heater or stove',
    'sewage backing up into the home',
  ],

  isFictionalDemo: true,
};
