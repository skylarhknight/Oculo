"""
Oculo cinematographer mannequin.

Builds the map-view character procedurally so the model can be reviewed and rebuilt:

    /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/blender/cinematographer.py

Outputs (relative to the repository root):
    apps/mobile/public/models/cinematographer.glb
    apps/mobile/public/models/cinematographer-token@2x.png
    apps/mobile/public/models/cinematographer-token@3x.png

Design: a designer's wooden mannequin reduced to ellipsoids, about seven heads tall,
faceless, in matte clay with one accent: a small red-orange cinematographer's scarf
whose two tails are chains of segments the app swings procedurally.

Conventions the app relies on (packages/scene-core/src/mannequin.ts):
  * origin at the feet, eye height exactly 1.0 unit, facing Blender -Y (glTF +Z);
  * every animated part is its own node with its origin at the joint pivot;
  * node names: root, hips, torso, neck, head, arm_L/R, forearm_L/R, leg_L/R,
    scarf_wrap, scarf_tail_A_1..4, scarf_tail_B_1..4.
"""

import math
import os
import sys

import bpy
from mathutils import Euler, Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "apps", "mobile", "public", "models")

CLAY = (0.929, 0.929, 0.949, 1.0)  # #EDEDF2
JOINT = (0.86, 0.86, 0.89, 1.0)
SCARF = (1.0, 0.353, 0.212, 1.0)  # #FF5A36

SEGMENTS, RINGS = 16, 9


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def material(name, color, roughness):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Roughness"].default_value = roughness
    mat.diffuse_color = color
    return mat


def ellipsoid(location, radii, mat, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=SEGMENTS, ring_count=RINGS, radius=1.0, location=location
    )
    obj = bpy.context.active_object
    obj.scale = radii
    obj.rotation_euler = Euler(rotation)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    bpy.ops.object.shade_smooth()
    obj.data.materials.append(mat)
    return obj


def limb(start, end, radius, mat):
    """An elongated ellipsoid spanning two joints, like a mannequin limb."""
    a, b = Vector(start), Vector(end)
    mid = (a + b) / 2
    length = (b - a).length
    direction = (b - a).normalized()
    rotation = Vector((0, 0, 1)).rotation_difference(direction).to_euler()
    return ellipsoid(mid, (radius, radius, length / 2 + radius * 0.35), mat, rotation)


def slab(location, size, mat, rotation=(0, 0, 0)):
    """A soft flat segment of fabric (bevelled box)."""
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=location)
    obj = bpy.context.active_object
    obj.scale = size
    obj.rotation_euler = Euler(rotation)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    bevel = obj.modifiers.new("soft", "BEVEL")
    bevel.width = min(size) * 0.4
    bevel.segments = 2
    bpy.ops.object.modifier_apply(modifier="soft")
    bpy.ops.object.shade_smooth()
    obj.data.materials.append(mat)
    return obj


def part(name, pieces, pivot, parent=None):
    """Joins pieces into one node whose origin sits at the joint pivot."""
    bpy.ops.object.select_all(action="DESELECT")
    for piece in pieces:
        piece.select_set(True)
    bpy.context.view_layer.objects.active = pieces[0]
    if len(pieces) > 1:
        bpy.ops.object.join()
    obj = bpy.context.active_object
    obj.name = name
    obj.data.name = name
    bpy.context.scene.cursor.location = pivot
    bpy.ops.object.origin_set(type="ORIGIN_CURSOR")
    if parent is not None:
        world = obj.matrix_world.copy()
        obj.parent = parent
        obj.matrix_world = world
    return obj


def empty(name, location, parent=None):
    obj = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = location
    if parent is not None:
        obj.parent = parent
        obj.location = Vector(location) - parent.matrix_world.translation
    return obj


def build():
    clay = material("clay", CLAY, 0.82)
    joint = material("joint", JOINT, 0.7)
    scarf = material("scarf", SCARF, 0.6)

    root = empty("root", (0, 0, 0))

    # Pelvis and hips (pivot at the waist).
    hips = part(
        "hips",
        [ellipsoid((0, 0, 0.535), (0.098, 0.068, 0.075), clay)],
        (0, 0, 0.56),
        root,
    )

    # Chest: a separate ellipsoid over a waist joint, the mannequin signature.
    torso = part(
        "torso",
        [
            ellipsoid((0, 0, 0.755), (0.114, 0.066, 0.13), clay),
            ellipsoid((0, 0, 0.615), (0.05, 0.045, 0.04), joint),
        ],
        (0, 0, 0.6),
        hips,
    )

    neck = part(
        "neck",
        [limb((0, 0, 0.87), (0, 0, 0.93), 0.034, joint)],
        (0, 0, 0.885),
        torso,
    )

    # Faceless, slightly egg-shaped head; its centre is the eye height (1.0).
    part(
        "head",
        [ellipsoid((0, 0.004, 1.0), (0.066, 0.072, 0.082), clay, (math.radians(-8), 0, 0))],
        (0, 0, 0.93),
        neck,
    )

    for side, sign in (("L", 1), ("R", -1)):
        shoulder = (sign * 0.14, 0, 0.845)
        elbow = (sign * 0.165, 0.005, 0.64)
        wrist = (sign * 0.172, -0.01, 0.46)
        arm = part(
            f"arm_{side}",
            [
                ellipsoid(shoulder, (0.036, 0.036, 0.036), joint),
                limb(shoulder, elbow, 0.03, clay),
            ],
            shoulder,
            torso,
        )
        part(
            f"forearm_{side}",
            [
                ellipsoid(elbow, (0.029, 0.029, 0.029), joint),
                limb(elbow, wrist, 0.026, clay),
                ellipsoid((wrist[0], wrist[1] - 0.005, wrist[2] - 0.045), (0.024, 0.017, 0.042), clay),
            ],
            elbow,
            arm,
        )
        hip = (sign * 0.058, 0, 0.5)
        knee = (sign * 0.064, 0, 0.27)
        ankle = (sign * 0.066, 0.005, 0.055)
        part(
            f"leg_{side}",
            [
                ellipsoid(hip, (0.042, 0.042, 0.042), joint),
                limb(hip, knee, 0.044, clay),
                ellipsoid(knee, (0.036, 0.036, 0.036), joint),
                limb(knee, ankle, 0.034, clay),
                ellipsoid((ankle[0], ankle[1] - 0.03, 0.024), (0.032, 0.066, 0.024), clay),
            ],
            hip,
            hips,
        )

    # Scarf: a smooth wrap around the neck, knotted front-left, two tails.
    bpy.ops.mesh.primitive_torus_add(
        major_segments=28,
        minor_segments=10,
        major_radius=0.05,
        minor_radius=0.019,
        location=(0, 0, 0.872),
    )
    ring = bpy.context.active_object
    ring.scale = (1.0, 0.92, 1.35)
    ring.rotation_euler = Euler((math.radians(-7), 0, 0))
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    bpy.ops.object.shade_smooth()
    ring.data.materials.append(scarf)
    knot = ellipsoid((0.03, -0.058, 0.858), (0.024, 0.02, 0.023), scarf)
    wrap = part("scarf_wrap", [ring, knot], (0, 0, 0.872), neck)

    # Each tail is a chain of segments hanging from the knot. The first segment
    # leans forward so the fabric clears the chest; the rest drape back down.
    segment = 0.044
    for tail, origin, lean, drape in (
        ("A", Vector((0.022, -0.07, 0.85)), (-22, 0, -5), 11),
        ("B", Vector((0.044, -0.066, 0.852)), (-16, 0, 24), 9),
    ):
        parent = wrap
        top = origin
        for index in range(1, 5):
            width = 0.034 - index * 0.003
            # Segments overlap slightly so the tail reads as one strip of fabric.
            center = top + Vector((0, 0, -segment * 0.56))
            piece = slab(center, (width, 0.008, segment * 1.18), scarf)
            node = part(f"scarf_tail_{tail}_{index}", [piece], top, parent)
            angle = lean if index == 1 else (drape, 0, 0)
            node.rotation_euler = Euler(tuple(math.radians(value) for value in angle))
            bpy.context.view_layer.update()
            parent = node
            top = node.matrix_world @ Vector((0, 0, 0)) + (
                node.matrix_world.to_quaternion() @ Vector((0, 0, -segment))
            )

    # A relaxed stance: arms slightly away from the body.
    bpy.data.objects["arm_L"].rotation_euler = Euler((0, math.radians(-7), 0))
    bpy.data.objects["arm_R"].rotation_euler = Euler((0, math.radians(7), 0))
    bpy.data.objects["forearm_L"].rotation_euler = Euler((math.radians(-10), 0, 0))
    bpy.data.objects["forearm_R"].rotation_euler = Euler((math.radians(-10), 0, 0))
    return root


def export_glb(root):
    os.makedirs(OUT, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in [root, *root.children_recursive]:
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(OUT, "cinematographer.glb"),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_materials="EXPORT",
        export_texcoords=False,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
    )


def render_token():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 48
    scene.cycles.use_denoising = True
    scene.render.film_transparent = True
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"

    world = bpy.data.worlds.new("studio")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.8, 0.82, 0.86, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.22
    scene.view_settings.exposure = -0.2
    scene.world = world

    key = bpy.data.lights.new("key", "AREA")
    key.energy = 38
    key.size = 1.2
    key_obj = bpy.data.objects.new("key", key)
    key_obj.location = (-1.1, -1.4, 1.9)
    key_obj.rotation_euler = (math.radians(50), 0, math.radians(-38))
    scene.collection.objects.link(key_obj)

    rim = bpy.data.lights.new("rim", "AREA")
    rim.energy = 26
    rim.size = 0.8
    rim_obj = bpy.data.objects.new("rim", rim)
    rim_obj.location = (1.0, 1.2, 1.5)
    rim_obj.rotation_euler = (math.radians(-55), 0, math.radians(140))
    scene.collection.objects.link(rim_obj)

    cam = bpy.data.cameras.new("token")
    cam.type = "ORTHO"
    cam.ortho_scale = 1.22
    cam_obj = bpy.data.objects.new("token", cam)
    cam_obj.location = (0.9, -1.55, 0.95)
    direction = Vector((0, 0, 0.55)) - cam_obj.location
    cam_obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    scene.collection.objects.link(cam_obj)
    scene.camera = cam_obj

    for scale, (width, height) in (("2x", (128, 160)), ("3x", (192, 240))):
        scene.render.resolution_x = width
        scene.render.resolution_y = height
        scene.render.resolution_percentage = 100
        scene.render.image_settings.file_format = "PNG"
        scene.render.image_settings.color_mode = "RGBA"
        scene.render.filepath = os.path.join(OUT, f"cinematographer-token@{scale}.png")
        bpy.ops.render.render(write_still=True)


def main():
    reset()
    root = build()
    export_glb(root)
    if "--no-render" not in sys.argv:
        render_token()
    print("cinematographer: wrote", OUT)


if os.environ.get("CINEMATOGRAPHER_LIBRARY") != "1":
    main()
