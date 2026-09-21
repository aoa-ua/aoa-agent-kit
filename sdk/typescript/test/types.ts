/**
 * Compile-time checks of the public types (`npm run typecheck`). Never run:
 * every call below sits inside an uncalled function.
 */
import {
  type AoaClient,
  createAoaClient,
  type EventSummary,
  type Order,
  type WebhookEventType,
} from '../src/index.js';

const assertType = <T>(_value: T): void => undefined;

export const typeChecks = async (client: AoaClient = createAoaClient()) => {
  const events = await client.searchEvents({ city: 'Київ', limit: 10 });
  assertType<EventSummary[]>(events.data);
  assertType<string | null | undefined>(events.meta?.nextCursor);

  const order = await client.getOrder({ paymentId: 'p1' });
  assertType<Order['status']>(order.data.status);

  const reservation = await client.createTableReservation({
    locationId: 'loc1',
    date: '2026-10-01',
    time: '19:00',
    partySize: 2,
    guest: { name: 'Typed by the guest', phone: '+380000000000' },
    confirmedByUser: true,
  });
  assertType<string>(reservation.data.reservationId);

  await client.createTableReservation({
    locationId: 'loc1',
    date: '2026-10-01',
    time: '19:00',
    partySize: 2,
    guest: { name: 'Typed by the guest', phone: '+380000000000' },
    // @ts-expect-error the booking must carry an explicit human confirmation
    confirmedByUser: false,
  });

  // @ts-expect-error eventId is required
  await client.getEvent({});

  // @ts-expect-error unknown webhook event type
  await client.createWebhook({ url: 'https://example.com', events: ['order.nope'] });

  const eventType: WebhookEventType = 'order.paid';
  await client.updateWebhook({ endpointId: 'wh1', events: [eventType] });

  for await (const location of client.paginate('searchLocations', { city: 'Київ' })) {
    assertType<string>(location.id);
  }

  // @ts-expect-error only GET list operations can be paginated
  client.paginate('createTicketCheckout');

  const batch = await client.batchOperations({
    operations: [{ id: 'a', path: '/events/e1/availability' }],
  });
  assertType<number>(batch.data[0].status);

  const checkout = await client.createTicketCheckout(
    {
      eventId: 'e1',
      tickets: [{ ticketTypeId: 'tt1', quantity: 1 }],
      buyer: { email: 'buyer@example.com', name: 'Test Buyer' },
    },
    { headers: { Prefer: 'respond-async' } },
  );
  assertType<string>(checkout.data.paymentUrl);
  if ('statusUrl' in checkout.data) assertType<string>(checkout.data.statusUrl);

  const byId = await client.request('getEventAvailability', { eventId: 'e1' });
  assertType<Record<string, number>>(byId.data.ticketTypes);
};
