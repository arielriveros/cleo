//! GLSL ES 300 -> WGSL, exposed to JavaScript.
//!
//! The engine keeps GLSL as the single source of truth for both backends, which means the WebGPU path
//! needs a translator — and, because user-authored custom materials are GLSL stored inside saved
//! projects, it needs one that runs *in the browser* rather than only at build time.
//!
//! The surface is deliberately one function. Everything naga can otherwise do (SPIR-V, MSL, HLSL,
//! reflection dumps) is a dependency and a payload we would ship to every player for nothing.

use wasm_bindgen::prelude::*;

/// Translate one shader stage.
///
/// `stage` is "vertex", "fragment" or "compute". Returns the WGSL source, or a JS `Error` whose message
/// is the diagnostic naga produced — the caller surfaces that to the material editor, so it has to stay
/// human-readable rather than being flattened to "compile failed".
#[wasm_bindgen]
pub fn glsl_to_wgsl(source: &str, stage: &str) -> Result<String, JsError> {
    let shader_stage = match stage {
        "vertex" => naga::ShaderStage::Vertex,
        "fragment" => naga::ShaderStage::Fragment,
        "compute" => naga::ShaderStage::Compute,
        other => return Err(JsError::new(&format!("unknown shader stage {other:?}"))),
    };

    let mut frontend = naga::front::glsl::Frontend::default();
    let options = naga::front::glsl::Options {
        stage: shader_stage,
        defines: Default::default(),
    };

    let module = frontend
        .parse(&options, source)
        .map_err(|e| JsError::new(&format!("GLSL parse failed: {e:?}")))?;

    // Validation is not optional here even though the browser re-validates the WGSL it is handed: the
    // WGSL backend needs the module info that validation produces, and a diagnostic pointing at the
    // GLSL is far more useful to whoever wrote it than one pointing at generated WGSL they never saw.
    let mut validator = naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::all(),
    );
    let info = validator
        .validate(&module)
        .map_err(|e| JsError::new(&format!("GLSL validation failed: {e:?}")))?;

    naga::back::wgsl::write_string(&module, &info, naga::back::wgsl::WriterFlags::empty())
        .map_err(|e| JsError::new(&format!("WGSL generation failed: {e:?}")))
}

/// Translate WGSL to GLSL ES 300 — the direction naga is actually built for.
///
/// This is the path wgpu itself uses to run WGSL on its WebGL2 backend, so it is naga's most exercised
/// combination by a wide margin. The probe results in WEBGPU_ROADMAP.md M3 are why it matters: naga's
/// GLSL *frontend* is Vulkan-flavoured and cannot read the OpenGL ES dialect this engine writes, while
/// its GLSL *backend* emits exactly that dialect.
#[wasm_bindgen]
pub fn wgsl_to_glsl(source: &str, stage: &str, entry_point: &str) -> Result<String, JsError> {
    let shader_stage = match stage {
        "vertex" => naga::ShaderStage::Vertex,
        "fragment" => naga::ShaderStage::Fragment,
        "compute" => naga::ShaderStage::Compute,
        other => return Err(JsError::new(&format!("unknown shader stage {other:?}"))),
    };

    let module = naga::front::wgsl::parse_str(source)
        .map_err(|e| JsError::new(&format!("WGSL parse failed: {e:?}")))?;

    let mut validator = naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::all(),
    );
    let info = validator
        .validate(&module)
        .map_err(|e| JsError::new(&format!("WGSL validation failed: {e:?}")))?;

    // WriterFlags::empty(), NOT the default.
    //
    // naga defaults to ADJUST_COORDINATE_SPACE, which emits
    //     gl_Position.yz = vec2(-gl_Position.y, gl_Position.z * 2.0 - gl_Position.w);
    // to convert WebGPU's clip space (Y down, depth 0..1) into OpenGL's. That is right for wgpu, whose
    // shaders are authored against WebGPU conventions. This engine is GL-convention everywhere — its
    // cameras, its projection matrices, its existing hand-written GLSL — so leaving the flag on would
    // render every WGSL-authored pass vertically flipped with wrong depth.
    //
    // Shaders here are therefore authored in GL convention and the generated GLSL is a drop-in. When
    // the WebGPU backend lands, the Y/depth difference belongs in the projection matrix, per backend,
    // which is where the rest of the engine already keeps that kind of convention.
    let options = naga::back::glsl::Options {
        version: naga::back::glsl::Version::Embedded { version: 300, is_webgl: true },
        writer_flags: naga::back::glsl::WriterFlags::empty(),
        ..Default::default()
    };
    let pipeline_options = naga::back::glsl::PipelineOptions {
        shader_stage,
        entry_point: entry_point.to_string(),
        multiview: None,
    };

    let mut out = String::new();
    let mut writer = naga::back::glsl::Writer::new(
        &mut out, &module, &info, &options, &pipeline_options,
        naga::proc::BoundsCheckPolicies::default(),
    )
    .map_err(|e| JsError::new(&format!("GLSL writer setup failed: {e:?}")))?;
    writer
        .write()
        .map_err(|e| JsError::new(&format!("GLSL generation failed: {e:?}")))?;
    Ok(out)
}

/// The naga version this artifact was built against, so a vendored `.wasm` can report its own
/// provenance instead of relying on a comment somewhere staying true.
#[wasm_bindgen]
pub fn naga_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
