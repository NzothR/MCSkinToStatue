"""兼容旧索引的重力类名；来自 1.7.10 基类及本实例 JAR 的继承链核对。"""

KNOWN_GRAVITY_CLASSES = frozenset(
    {
        "net.minecraft.block.BlockFalling",
        "net.minecraft.block.BlockSand",
        "net.minecraft.block.BlockGravel",
        "net.minecraft.block.BlockAnvil",
        "net.minecraft.block.BlockDragonEgg",
        "ganymedes01.etfuturum.blocks.BaseSubtypesSand",
        "ganymedes01.etfuturum.blocks.BlockConcretePowder",
        "ganymedes01.etfuturum.blocks.BlockOldGravel",
        "com.dreammaster.block.ZincGravelOre",
        "tconstruct.world.blocks.GravelOre",
        "team.chisel.block.BlockCarvableSand",
        "mods.natura.blocks.nether.HeatSand",
        "com.miaokatze.gtsr.common.blocks.BlockProsperityFalling",
        "crazypants.enderio.block.BlockDarkSteelAnvil",
        "mods.railcraft.common.blocks.anvil.BlockRCAnvil",
        "tb.common.block.BlockThaumicAnvil",
        "tb.common.block.BlockVoidAnvil",
        "chylex.hee.block.BlockDragonEggCustom",
        "com.emoniph.witchery.blocks.BlockInfinityEgg",
        "com.xir.NHUtilities.common.blocks.CustomDragonEgg",
        "micdoodle8.mods.galacticraft.planets.mars.blocks.BlockCreeperEgg",
        # AmunRa 在自身 tick 逻辑中创建 EntityFallingBlock，未继承 BlockFalling。
        "de.katzenpapst.amunra.block.BlockFallingMeta",
    }
)


def affected_by_gravity(block: dict) -> bool:
    """新索引使用运行时标记和完整继承链，旧索引使用已确认的兼容类名。"""
    return bool(block.get("gravity_affected")) or any(
        name in KNOWN_GRAVITY_CLASSES
        for name in block.get("class_hierarchy", [block["class_name"]])
    )
