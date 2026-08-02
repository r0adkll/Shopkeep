-- Track Etsy's receipt status: canceled/refunded orders hide from the board,
-- cancellations release reservations, shipped-state echo auto-completes.
alter table orders add column platform_status text not null default 'paid';
