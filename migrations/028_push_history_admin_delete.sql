-- Allow authenticated admins to DELETE push history
DROP POLICY IF EXISTS "Admins can delete push history" ON public.push_history;
CREATE POLICY "Admins can delete push history" ON public.push_history
    FOR DELETE
    USING (
        EXISTS (
            SELECT 1 FROM public.users u
            WHERE u.id = auth.uid() AND u.role = 'admin'
        )
    );
