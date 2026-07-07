import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../common/logger.js";
import { findNearbyDrivers } from "../matching/matching.service.js";

/**
 * A lightweight scheduler that polls the `scheduled_jobs` table and 
 * materializes jobs whose `next_run_at` has passed into active `rides`.
 */
export function startScheduler() {
  logger.info("Fleet Scheduler started...");

  // Poll every 60 seconds
  setInterval(async () => {
    try {
      const now = new Date().toISOString();
      
      const { data: jobs, error } = await supabaseAdmin
        .from("scheduled_jobs")
        .select("*")
        .eq("is_active", true)
        .lte("next_run_at", now);

      if (error || !jobs || jobs.length === 0) return;

      for (const job of jobs) {
        logger.info({ jobId: job.id }, "Materializing scheduled job");

        // 1. Calculate fare / routing (mocked here for simplicity, in reality call OSRM and contracts again)
        // 2. Insert into rides table
        const { data: ride, error: rideError } = await supabaseAdmin
          .from("rides")
          .insert({
            origin_lat: job.origin_lat,
            origin_lng: job.origin_lng,
            origin_address: job.origin_address,
            dest_lat: job.dest_lat,
            dest_lng: job.dest_lng,
            dest_address: job.dest_address,
            vehicle_type: job.vehicle_type,
            service_type: "fleet",
            cargo_weight_kg: job.cargo_weight_kg,
            distance_m: 0, // Placeholder
            fare_estimate: 0, // Placeholder
            status: "requested",
            payment_method: "cash",
            payment_status: "pending",
          })
          .select()
          .single();

        if (rideError) {
          logger.error({ jobId: job.id, err: rideError }, "Failed to materialize scheduled job");
          continue;
        }

        // 3. Mark job as complete (or calculate next_run_at if recurring)
        if (!job.is_recurring) {
          await supabaseAdmin
            .from("scheduled_jobs")
            .update({ is_active: false })
            .eq("id", job.id);
        } else {
          // If recurring, calculate the next run time using a cron library (mocked to +1 day here)
          const nextDay = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
          await supabaseAdmin
            .from("scheduled_jobs")
            .update({ next_run_at: nextDay })
            .eq("id", job.id);
        }

        // 4. Trigger matching
        findNearbyDrivers(
          job.origin_lat, 
          job.origin_lng, 
          job.vehicle_type, 
          ride.id, 
          "fleet", 
          job.cargo_weight_kg
        ).catch(() => {});
      }
    } catch (err) {
      logger.error({ err }, "Scheduler loop error");
    }
  }, 60 * 1000);
}
