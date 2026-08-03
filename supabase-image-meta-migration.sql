alter table public.ledger_entries add column if not exists image_meta jsonb not null default '[]'::jsonb;

update public.ledger_entries
set image_meta = case
  when jsonb_typeof(image) = 'object' and image ? 'items' then (
    select coalesce(jsonb_agg(jsonb_build_object(
      'name', coalesce(item->>'name', '记录图片'),
      'type', coalesce(item->>'type', 'image/*'),
      'size', coalesce((item->>'size')::numeric, 0),
      'originalSize', coalesce((item->>'originalSize')::numeric, 0),
      'hasImage', true
    )), '[]'::jsonb)
    from jsonb_array_elements(image->'items') as item
  )
  when jsonb_typeof(image) = 'object' and image ? 'dataUrl' then jsonb_build_array(jsonb_build_object(
    'name', coalesce(image->>'name', '记录图片'),
    'type', coalesce(image->>'type', 'image/*'),
    'size', coalesce((image->>'size')::numeric, 0),
    'originalSize', coalesce((image->>'originalSize')::numeric, 0),
    'hasImage', true
  ))
  else '[]'::jsonb
end
where image is not null
  and (image_meta is null or image_meta = '[]'::jsonb);
