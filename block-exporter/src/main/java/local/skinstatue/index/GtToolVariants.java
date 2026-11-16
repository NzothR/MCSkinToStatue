package local.skinstatue.index;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;

/** GTNH 2.9 tool material appearances, generated lazily without a compile-time GregTech dependency. */
final class GtToolVariants {

    private final Item item;
    private final List<ItemStack> templates;
    private final List<Object> materials = new ArrayList<>();
    private final Method factory;
    private final Method primary;
    private final Method secondary;
    private final Method electric;
    private final Method localized;
    private int cursor;

    static GtToolVariants forItem(Item item, List<ItemStack> creative) throws ReflectiveOperationException {
        for (Class<?> type = item.getClass(); type != null; type = type.getSuperclass()) {
            if ("gregtech.api.items.MetaGeneratedTool".equals(type.getName()))
                return new GtToolVariants(item, creative, type);
        }
        return null;
    }

    private GtToolVariants(Item item, List<ItemStack> creative, Class<?> tool) throws ReflectiveOperationException {
        this.item = item;
        Class<?> material = Class.forName(
            "gregtech.api.enums.Materials",
            true,
            item.getClass()
                .getClassLoader());
        factory = tool.getMethod("getToolWithStats", int.class, int.class, material, material, long[].class);
        primary = tool.getMethod("getPrimaryMaterial", ItemStack.class);
        secondary = tool.getMethod("getSecondaryMaterial", ItemStack.class);
        electric = tool.getMethod("getElectricStats", ItemStack.class);
        localized = material.getMethod("getLocalizedNameForItem", String.class);
        java.lang.reflect.Field durability = material.getField("mDurability");
        for (Object value : (Collection<?>) material.getMethod("getAll")
            .invoke(null)) {
            if (durability.getInt(value) > 0) materials.add(value);
        }
        Map<Integer, ItemStack> byDamage = new LinkedHashMap<>();
        for (ItemStack stack : creative) byDamage.putIfAbsent(stack.getItemDamage(), stack);
        templates = new ArrayList<>(byDamage.values());
    }

    boolean hasNext() {
        return cursor < total();
    }

    int total() {
        return templates.size() * materials.size() * 2;
    }

    ItemStack next() throws ReflectiveOperationException {
        int index = cursor++;
        ItemStack template = templates.get(index / (materials.size() * 2));
        Object material = materials.get((index / 2) % materials.size());
        Object head = index % 2 == 0 ? material : primary.invoke(null, template);
        Object handle = index % 2 == 0 ? secondary.invoke(null, template) : material;
        Long[] boxed = (Long[]) electric.invoke(item, template);
        long[] power = null;
        if (boxed != null) {
            power = new long[boxed.length];
            for (int i = 0; i < boxed.length; i++) power[i] = boxed[i];
        }
        return (ItemStack) factory.invoke(item, template.getItemDamage(), 1, head, handle, power);
    }

    String[] names(ItemStack stack) throws ReflectiveOperationException {
        return new String[] { (String) localized.invoke(primary.invoke(null, stack), "%material"),
            (String) localized.invoke(secondary.invoke(null, stack), "%material") };
    }
}
