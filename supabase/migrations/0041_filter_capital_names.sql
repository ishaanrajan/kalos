-- =============================================================================
-- 0041_filter_capital_names.sql
--
-- The filter roster in lib/filters.ts was renamed wholesale -- the 2015
-- Instagram-derived names (Clarendon, Valencia, X-Pro II, ...) are now capital
-- cities, and several of the recipes that clustered too close together
-- (Juno/Lark/Ludwig/Amaro/Valencia all being sepia+contrast+saturate variants
-- distinguished mainly by overlay tint) were reworked to actually look
-- distinct. `posts.filter_name` is plain free text with no FK (0002_schema.sql)
-- and `getFilter()` silently falls back to Normal for a name it doesn't
-- recognize -- so without this, every already-posted photo using one of these
-- filters would render unfiltered the next time anyone opens it. This just
-- carries each existing row's old name forward to its new one; it does not
-- touch pixels, only the label a post already points at.
-- =============================================================================

update public.posts
set filter_name = case filter_name
  when 'Clarendon' then 'Oslo'
  when 'Gingham'   then 'Copenhagen'
  when 'Juno'      then 'Manila'
  when 'Lark'      then 'Wellington'
  when 'Ludwig'    then 'Vienna'
  when 'Aden'      then 'Muscat'
  when 'Amaro'     then 'Nairobi'
  when 'Mayfair'   then 'Valletta'
  when 'Rise'      then 'Cairo'
  when 'Valencia'  then 'Lima'
  when 'X-Pro II'  then 'Reykjavik'
  when 'Lo-Fi'     then 'Ulaanbaatar'
  when 'Nashville' then 'Havana'
  when '1977'      then 'Bangkok'
  when 'Toaster'   then 'Santiago'
  when 'Willow'    then 'Budapest'
  when 'Inkwell'   then 'Berlin'
  else filter_name
end
where filter_name in (
  'Clarendon', 'Gingham', 'Juno', 'Lark', 'Ludwig', 'Aden', 'Amaro', 'Mayfair',
  'Rise', 'Valencia', 'X-Pro II', 'Lo-Fi', 'Nashville', '1977', 'Toaster',
  'Willow', 'Inkwell'
);
