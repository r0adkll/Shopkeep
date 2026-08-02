-- Phase 4: user-defined queue lanes with arrival-only routing rules
-- (vault: Order Management, locked queue concept).

create table queue_lanes (
    id       bigint generated always as identity primary key,
    name     text not null,
    position int  not null,
    role     text check (role in ('intake', 'done'))
);

create table lane_rules (
    id        bigint generated always as identity primary key,
    lane_id   bigint not null references queue_lanes (id) on delete cascade,
    position  int    not null,
    condition text   not null, -- personalized | shortfall | unmatched | adhoc_packaging | platform | units_gte
    value     text
);

-- Seed: the original six categories, spec behaviors expressed as rules.
insert into queue_lanes (name, position, role) values
    ('New', 0, 'intake'),
    ('Designing', 1, null),
    ('Waiting for supplies', 2, null),
    ('Processing', 3, null),
    ('Preparing to ship', 4, null),
    ('Completed', 5, 'done');

insert into lane_rules (lane_id, position, condition)
select id, 0, 'personalized' from queue_lanes where name = 'Designing';
insert into lane_rules (lane_id, position, condition)
select id, 0, 'shortfall' from queue_lanes where name = 'Waiting for supplies';

alter table orders add column lane_id bigint references queue_lanes (id);
update orders set lane_id = (select id from queue_lanes where role = 'intake');
alter table orders add column flag_short boolean not null default false;
alter table orders add column flag_adhoc boolean not null default false;
alter table orders add column completed_at timestamptz;
