import { Column, Entity, Index, JoinColumn, OneToOne, type Relation } from 'typeorm';
import { BaseEntity } from './base.entity.js';
import { JobApplication } from './job-application.entity.js';

export enum EmployeeStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

/** One working block on an ISO weekday (1 = Monday ... 7 = Sunday), in the company timezone. */
export type ScheduleBlock = { weekday: number; start: string; end: string };

@Entity({ name: 'employees' })
export class Employee extends BaseEntity {
  @Column({ type: 'varchar', length: 100 })
  firstName!: string;

  @Column({ type: 'varchar', length: 100 })
  lastName!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 320 })
  email!: string;

  // E.164
  @Column({ type: 'varchar', length: 32, nullable: true })
  phone!: string | null;

  @Column({ type: 'varchar', length: 160 })
  position!: string;

  @Column({ type: 'varchar', length: 120, nullable: true })
  department!: string | null;

  @Column({ type: 'date' })
  startDate!: string;

  @Index()
  @Column({ type: 'enum', enum: EmployeeStatus, default: EmployeeStatus.ACTIVE })
  status!: EmployeeStatus;

  // Weekly working hours; an empty schedule means no regular hours yet.
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  schedule!: ScheduleBlock[];

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  // Set when the employee was hired through an application; null for manual additions.
  @OneToOne(() => JobApplication, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'application_id' })
  application!: Relation<JobApplication> | null;

  // Unique through the one-to-one relation: an application hires at most one employee.
  @Column({ name: 'application_id', type: 'uuid', nullable: true })
  applicationId!: string | null;

  // Code of the vacancy they were hired for; kept if the application is deleted later.
  @Column({ type: 'varchar', length: 32, nullable: true })
  jobCode!: string | null;
}
