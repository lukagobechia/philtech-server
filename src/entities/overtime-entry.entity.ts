import { Column, Entity, Index, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { AdminUser } from './admin-user.entity.js';
import { BaseEntity } from './base.entity.js';
import { Employee } from './employee.entity.js';

export enum OvertimeStatus {
  // Running: started, not ended yet.
  ACTIVE = 'active',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

@Entity({ name: 'overtime_entries' })
@Index('UQ_overtime_one_active_per_employee', ['employeeId'], { unique: true, where: "status = 'active'" })
export class OvertimeEntry extends BaseEntity {
  @ManyToOne(() => Employee, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'employee_id' })
  employee!: Relation<Employee>;

  @Index()
  @Column({ name: 'employee_id', type: 'uuid' })
  employeeId!: string;

  @Index()
  @Column({ type: 'timestamptz' })
  startedAt!: Date;

  // Set when the overtime ends; while active, plannedEndAt (if any) ends it automatically.
  @Column({ type: 'timestamptz', nullable: true })
  endedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  plannedEndAt!: Date | null;

  @Column({ type: 'varchar', length: 500 })
  reason!: string;

  @Index()
  @Column({ type: 'enum', enum: OvertimeStatus, default: OvertimeStatus.ACTIVE })
  status!: OvertimeStatus;

  @ManyToOne(() => AdminUser, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'started_by_id' })
  startedBy!: Relation<AdminUser> | null;

  @Column({ name: 'started_by_id', type: 'uuid', nullable: true })
  startedById!: string | null;

  @ManyToOne(() => AdminUser, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'ended_by_id' })
  endedBy!: Relation<AdminUser> | null;

  // Null with an endedAt means it ended on its own at the planned time.
  @Column({ name: 'ended_by_id', type: 'uuid', nullable: true })
  endedById!: string | null;
}
