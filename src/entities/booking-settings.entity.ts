import { Column, Entity } from 'typeorm';
import { BaseEntity } from './base.entity.js';

export type AvailabilityRule = {
  id: string;
  label: string | null;
  // ISO weekdays, 1 = Monday ... 7 = Sunday.
  weekdays: number[];
  // Local start times, HH:mm.
  times: string[];
  // Inclusive local dates (YYYY-MM-DD); null = open-ended.
  startDate: string | null;
  endDate: string | null;
  // 1 = every week, 2 = every other week, ... counted from the week of startDate.
  intervalWeeks: number;
};

// Replaces the recurring times on one date; no times = unavailable that day.
export type DateOverride = {
  date: string;
  times: string[];
};

// Single-row table holding the bookable schedule that admins edit in the panel.
@Entity({ name: 'booking_settings' })
export class BookingSettings extends BaseEntity {
  @Column({ type: 'varchar', length: 64 })
  timezone!: string;

  @Column({ type: 'int' })
  slotMinutes!: number;

  @Column({ type: 'int' })
  minLeadHours!: number;

  @Column({ type: 'int' })
  maxDaysAhead!: number;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  rules!: AvailabilityRule[];

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  dateOverrides!: DateOverride[];
}
