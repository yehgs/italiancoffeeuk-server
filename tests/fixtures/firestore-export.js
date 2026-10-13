// Realistic (but invented) Firestore export, including the messy shapes the old forms produced.
export const exportData = () => ({
  collections: {
    tags: [{ id: 't1', tag: 'Espresso' }, { id: 't2', tag: ' espresso ' }, { id: 't3', tag: 'Organic' }],
    category: [{ id: 'c1', category: 'Beans' }],
    region: [{ id: 'r1', region: 'Lazio' }],
    manufacturerType: [
      { id: 'mt1', manufacturerType: [{ typeName: 'Roaster', typeImage: 'https://res.cloudinary.com/x/roaster.png' }] },
      { id: 'mt2', manufacturerType: [{ typeName: 'Machine Maker', typeImage: 'https://res.cloudinary.com/x/machine.png' }] },
    ],
    manufacturer: [
      {
        id: 'm1', company: 'Illy Caffè', province: 'Trieste', manufacturerCountry: 'Italy',
        position: [45.65, 13.77], logo: 'https://res.cloudinary.com/x/illy.png',
        createdAt: { _seconds: 1700000000, _nanoseconds: 0 }, company_rate: '4',
        sales_online: true, academy: '', merchandise: '', socials: { facebook: '' }, terms: 'ui-state-key',
        manufacturerType: [{ typeName: 'Roaster', typeImage: 'https://res.cloudinary.com/x/roaster.png' }],
        'COFFEE BEANS': [{ name: 'Classico', price: '12.50', currency: '€', images: [''], videos: [''] }],
        'ESE PODS': [{ name: 'Pods', price: 4, currency: '€' }],
        products: [{ name: 'Machine', price: 100, currency: '€', image: 'https://res.cloudinary.com/x/m.png' }],
        reviews: [
          { uid: 'fbU1', name: 'Jane Doe', comment: 'Lovely', rate: 5, createdAt: { _seconds: 1700001000, _nanoseconds: 0 } },
          { uid: 'fbU2', name: 'Sam', comment: 'Ok', rate: 0, createdAt: '2024-01-02T00:00:00Z' },
          { uid: 'fbU3', name: 'Ghost', comment: '', rate: 3 },
        ],
      },
      { id: 'm2', company: 'Lavazza', province: 'Turin', position: [120.5, 40.1] /* entered lon,lat */ },
      { id: 'm3', company: 'ILLY caffè', province: 'Dup' }, // duplicate company
      { id: 'm4', province: 'No name' }, // invalid
    ],
    countries: [{ id: 'co1', company: 'Illy Caffè', country: ['Italy', 'France'] }],
    currency: [
      { id: 'cu1', company: 'illy caffè', currency: [{ name: 'dollar', symbol: '$', rate: 1.08 }, { name: 'bad', symbol: '', rate: 0 }] },
      { id: 'cu2', company: 'Nobody', currency: [] },
    ],
    payment: [{ id: 'p1', company: 'Illy Caffè', payment: ['Stripe', 'stripe', 'PayPal'] }],
    delivery: [
      // legacy bug: the 2nd partner ended up under `currency`, without price
      { id: 'd1', company: 'Illy Caffè', delivery: [{ name: 'DHL', timeFrame: '2 days', price: 10 }], currency: [{ name: 'UPS', timeFrame: '4 days', serviceType: 'Express' }] },
    ],
    admins: [
      { id: 'a1', firstName: 'Ada', lastName: 'Min', email: 'Ada@Example.com', password: 'plaintext-secret-1', role: 'superadmin' },
      { id: 'a2', firstName: 'Bo', lastName: 'Admin', email: 'bo@example.com', password: 'plaintext-secret-2', role: 'admin' },
    ],
    users: [
      { id: 'u1', uid: 'fbU1', first_name: 'Jane', last_name: 'Doe', email: 'Jane@Example.com', phone: '123', address: '1 St', zipCode: '9', delivery_address: true, createdAt: { _seconds: 1690000000, _nanoseconds: 0 } },
      { id: 'u2', uid: 'fbDup', first_name: 'Jane', last_name: 'Again', email: 'jane@example.com' },
    ],
    subscribers: [{ id: 's1', email: 'Fan@Example.com' }, { id: 's2', email: 'fan@example.com' }, { id: 's3', email: 'other@example.com' }],
    carts: [{ id: 'fbU1', items: [{ product: { name: 'Classico' }, quantity: 1 }] }],
  },
  authUsers: [
    { uid: 'fbU1', email: 'jane@example.com', displayName: 'Jane Doe', metadata: { creationTime: 'Tue, 01 Aug 2023 10:00:00 GMT' } },
    { uid: 'fbU9', email: 'authonly@example.com', displayName: 'Auth Only Person', disabled: false },
  ],
});
